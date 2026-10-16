// ライブ描画のセッション音声(L5、7.6): Opus を WebCodecs で復号し、Web Audio で少し先に予約して鳴らす。
// 全体のミュート中とキャンバスが隠れている間は音量を 0 にする(復号は続ける)
import { useEffect, useRef } from 'react';
import type { LiveAudioConfig } from '../protocol/LiveAudioConfig';

/** 揺らぎを吸収するため、これだけ先に予約する(秒) */
const LEAD = 0.05;
/** 予約がこれより先に積み上がったら詰め直す(遅延を積み上げない) */
const MAX_AHEAD = 0.3;

declare global {
  interface Window {
    /** テストから読む値(受け入れ基準: 440 Hz の音がブラウザで 440 Hz として検出される) */
    dewTest?: { audioPeakHz(): number | null };
  }
}

export function useLiveAudio(enabled: boolean, muted: boolean) {
  const gain = useRef<GainNode | null>(null);

  useEffect(() => {
    if (!enabled || typeof AudioDecoder === 'undefined') return;
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    const g = ctx.createGain();
    g.gain.value = 0;
    analyser.connect(g).connect(ctx.destination);
    gain.current = g;
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

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live-audio`);
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

    // 一番強い周波数(放物線で補間して、ビンの幅より細かく求める)
    window.dewTest = {
      audioPeakHz: () => {
        const bins = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(bins);
        let best = 1;
        for (let i = 1; i < bins.length - 1; i++) if (bins[i]! > bins[best]!) best = i;
        if (bins[best]! < -90) return null;
        const [a, b, c] = [bins[best - 1]!, bins[best]!, bins[best + 1]!];
        const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
        return ((best + shift) * ctx.sampleRate) / analyser.fftSize;
      },
    };
    void ctx.resume();
    return () => {
      ws.close();
      if (decoder.state !== 'closed') decoder.close();
      void ctx.close();
      gain.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (gain.current) gain.current.gain.value = muted ? 0 : 1;
  });
}
