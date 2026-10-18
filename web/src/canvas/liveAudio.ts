// ライブ描画の音(L5、7.6): Opus を WebCodecs で復号し、Web Audio で少し先に予約して鳴らす。
// セッション音声(どのウィンドウにも結びつかない音)と、ウィンドウごとのアプリの音(ADR 0013)を、
// 1つの AudioContext で混ぜる。鳴らさない間は音量を 0 にする(復号は続ける)
import { useEffect, useRef } from 'react';
import type { LiveAudioConfig } from '../protocol/LiveAudioConfig';

/** 揺らぎを吸収するため、これだけ先に予約する(秒) */
const LEAD = 0.05;
/** 予約がこれより先に積み上がったら詰め直す(遅延を積み上げない) */
const MAX_AHEAD = 0.3;

declare global {
  interface Window {
    /** テストから読む値(受け入れ基準: 440 Hz の音がブラウザで 440 Hz として検出される)。鳴らす設定の音だけで測る */
    dewTest?: { audioPeakHz(): number | null };
  }
}

/** 鳴らしている音1本 */
export type LiveSound = { setAudible(on: boolean): void; close(): void };

/** 一番強い周波数と、その強さ(dB)。放物線で補間して、ビンの幅より細かく求める */
function peakOf(analyser: AnalyserNode, sampleRate: number) {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  let best = 1;
  for (let i = 1; i < bins.length - 1; i++) if (bins[i]! > bins[best]!) best = i;
  const [a, b, c] = [bins[best - 1]!, bins[best]!, bins[best + 1]!];
  const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
  return { hz: ((best + shift) * sampleRate) / analyser.fftSize, db: b };
}

/** 音を混ぜる場所。鳴らしている音がある間だけ AudioContext を持つ */
export class LiveAudioMix {
  private ctx: AudioContext | null = null;
  private users = 0;
  /** 鳴らしている音ごとの、音量をかける前の測定(テスト用) */
  private meters = new Map<AnalyserNode, { audible: boolean }>();

  private open() {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    // 鳴らす設定になっている音のうち、一番強い周波数。音量の後で測ると、Chrome は音量 0 の後ろの測定を
    // 止めて最後の値を返し続けることがあるため、音ごとに音量の前で測る
    window.dewTest = {
      audioPeakHz: () => {
        let best: { hz: number; db: number } | null = null;
        for (const [analyser, m] of this.meters) {
          if (!m.audible) continue;
          const p = peakOf(analyser, ctx.sampleRate);
          if (!best || p.db > best.db) best = p;
        }
        return best && best.db >= -90 ? best.hz : null;
      },
    };
    void ctx.resume();
    this.ctx = ctx;
    return ctx;
  }

  /** `path` の WebSocket の音を鳴らし始める。最初は鳴らさない(setAudible で切り替える) */
  play(path: string): LiveSound {
    if (typeof AudioDecoder === 'undefined') return { setAudible: () => {}, close: () => {} };
    const ctx = this.ctx ?? this.open();
    this.users += 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    analyser.connect(gain).connect(ctx.destination);
    const meter = { audible: false };
    this.meters.set(analyser, meter);
    let playhead = 0;
    const decoder = new AudioDecoder({
      output: (data) => {
        const buffer = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
        for (let ch = 0; ch < data.numberOfChannels; ch++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
          buffer.copyToChannel(plane, ch);
        }
        data.close();
        const now = ctx.currentTime;
        if (playhead < now || playhead - now > MAX_AHEAD) playhead = now + LEAD;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser);
        src.start(playhead);
        playhead += buffer.duration;
      },
      error: () => {},
    });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (m) => {
      if (typeof m.data === 'string') {
        const c = JSON.parse(m.data) as LiveAudioConfig;
        decoder.configure({ codec: c.codec, sampleRate: c.sampleRate, numberOfChannels: c.numberOfChannels });
        return;
      }
      if (decoder.state !== 'configured') return;
      const buf = m.data as ArrayBuffer;
      const timestamp = Number(new DataView(buf).getBigUint64(0));
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(buf, 8) }));
    };
    return {
      setAudible: (on) => {
        gain.gain.value = on ? 1 : 0;
        meter.audible = on;
      },
      close: () => {
        ws.close();
        if (decoder.state !== 'closed') decoder.close();
        gain.disconnect();
        this.meters.delete(analyser);
        this.users -= 1;
        if (this.users === 0) {
          void ctx.close();
          this.ctx = null;
        }
      },
    };
  }
}

/** `path` の音を、`audible` の間だけ鳴らす(path が null なら何もしない) */
export function useLiveSound(mix: LiveAudioMix, path: string | null, audible: boolean) {
  const sound = useRef<LiveSound | null>(null);
  useEffect(() => {
    if (!path) return;
    const s = mix.play(path);
    sound.current = s;
    return () => {
      s.close();
      sound.current = null;
    };
  }, [mix, path]);
  useEffect(() => {
    sound.current?.setAudible(audible);
  });
}
