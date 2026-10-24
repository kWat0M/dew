// キャンバス上の1つのウィンドウ。動画・音声・画像を表示し、下部に再生コントロールを出す(4.2、F2、F5)
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MediaKind } from '../protocol/MediaKind';
import type { Probe } from '../protocol/Probe';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { frameAt, frameFrom, seekTimeFor } from './frames';
import { ImageView, type ImageApi } from './ImageView';
import { Controls, SPEEDS } from './Controls';
import { useVideoSource } from './source';
import { WindowFrame, type FrameProps } from './WindowFrame';


/** キャンバスのキー操作から呼ぶ操作 */
export type PlayerApi = {
  toggle(): void;
  isPaused(): boolean;
  /** 同期再生に使う動画の要素(画像なら null) */
  video(): HTMLVideoElement | null;
  setPlaying(playing: boolean): void;
  seekBy(sec: number): void;
  step(dir: 1 | -1): void;
  seekFraction(f: number): void;
  speed(dir: 1 | -1): void;
  ab(): void;
  toggleMute(): void;
  toggleZoom(): void;
  fullscreen(): void;
  /** 比較ウィンドウの表示を切り替える(c) */
  cycleMode?(): void;
  /** 画像の拡大・縮小(+ / -) */
  zoomBy?(f: number): void;
  /** 画像の表示位置を動かす(操作モードの hjkl) */
  panBy?(dx: number, dy: number): void;
};

type Props = FrameProps & {
  id: number;
  path: string;
  media: MediaKind;
  /** 音を出すか(全体のミュート中は出さない。複数あるときはフォーカス中だけ。7.6) */
  audible: boolean;
  /** 音声があるか分かったとき(変わらない関数を渡す) */
  onHasAudio: (id: number, has: boolean) => void;
  api: Ref<PlayerApi | null>;
};

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export function PlayerWindow({ api: apiRef, ...p }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const win = useRef<HTMLElement>(null);
  /**
   * 表示中のフレーム番号。requestVideoFrameCallback で更新し、自分でシークしたときは行き先をすぐ入れる
   * (シーク直後はその通知が遅れ、一時停止直後は currentTime が表示中のフレームより手前になることがあるため)
   */
  const shown = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [frame, setFrame] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  /** 本体を押し始めたときに操作モードだったか(1回目のクリックで操作モードに入り、2回目から再生 / 停止。5.1) */
  const wasOp = useRef(false);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const imageApi = useRef<ImageApi | null>(null);
  const timed = p.media === 'video' || p.media === 'audio';
  const abRef = useRef(ab);
  useEffect(() => {
    abRef.current = ab;
  }, [ab]);

  const fail = useCallback((message: string) => setStatus({ kind: 'error', message }), []);

  // 音声があるかをキャンバスへ知らせる(全体のミュートボタンの表示に使う)
  const { onHasAudio, id } = p;
  const onProbe = useCallback((pr: Probe) => onHasAudio(id, !!pr.audioCodec), [onHasAudio, id]);
  const { probe, ranges } = useVideoSource(video, p.path, timed, { video: p.media === 'video', onProbe, onError: fail });

  // 表示中のフレームを追う(7.5)。A-B ループの折り返しもここで行う
  useEffect(() => {
    const v = video.current;
    if (!v || !probe) return;
    let handle = 0;
    const onFrame: VideoFrameRequestCallback = (_, meta) => {
      const n = frameAt(probe.frameTimes, meta.mediaTime);
      shown.current = n;
      setFrame(n);
      const { a, b } = abRef.current;
      if (a !== null && b !== null && meta.mediaTime >= b) v.currentTime = a;
      handle = v.requestVideoFrameCallback(onFrame);
    };
    handle = v.requestVideoFrameCallback(onFrame);
    return () => v.cancelVideoFrameCallback(handle);
  }, [probe]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = muted || !p.audible;
    v.volume = volume;
  }, [muted, volume, p.audible]);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v || !probe) return;
    const to = Math.max(0, Math.min(probe.duration, t));
    shown.current = frameAt(probe.frameTimes, to);
    v.currentTime = to;
  }, [probe]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (v) void (v.paused ? v.play() : Promise.resolve(v.pause())).catch(() => {});
  }, []);
  const seekBy = useCallback((sec: number) => seek((video.current?.currentTime ?? 0) + sec), [seek]);
  const stepFrame = useCallback(
    (dir: 1 | -1) => {
      const v = video.current;
      if (!v || !probe || probe.frameTimes.length === 0) return;
      v.pause();
      seek(seekTimeFor(probe.frameTimes, shown.current + dir, probe.duration));
    },
    [probe, seek],
  );
  const setSpeed = useCallback((r: number) => {
    const v = video.current;
    if (v) {
      // 読み込み中に変えても、読み込み後に 1 倍へ戻らないよう既定の速度も変える
      v.defaultPlaybackRate = r;
      v.playbackRate = r;
    }
    setRate(r);
  }, []);

  useImperativeHandle(apiRef, () => ({
    toggle: togglePlay,
    isPaused: () => video.current?.paused ?? true,
    video: () => (timed ? video.current : null),
    setPlaying: (on) => {
      const v = video.current;
      if (v) void (on ? v.play() : Promise.resolve(v.pause())).catch(() => {});
    },
    seekBy,
    step: stepFrame,
    seekFraction: (f) => {
      if (!probe) return;
      const t = probe.duration * f;
      seek(probe.frameTimes.length ? seekTimeFor(probe.frameTimes, frameFrom(probe.frameTimes, t), probe.duration) : t);
    },
    speed: (dir) => {
      const v = video.current;
      if (!v) return;
      const i = SPEEDS.indexOf(v.playbackRate);
      setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))]!);
    },
    ab: () => {
      const t = video.current?.currentTime ?? 0;
      setAb((s) => (s.a === null ? { a: t, b: null } : s.b === null ? (t > s.a ? { a: s.a, b: t } : { a: t, b: s.a }) : { a: null, b: null }));
    },
    toggleMute: () => setMuted((m) => !m),
    toggleZoom: () => (imageApi.current ? imageApi.current.toggleActual() : setZoom((z) => (z === 'fit' ? 'actual' : 'fit'))),
    zoomBy: (f) => imageApi.current?.zoomBy(f),
    panBy: (dx, dy) => imageApi.current?.panBy(dx, dy),
    fullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void win.current?.requestFullscreen();
    },
  }), [probe, seek, togglePlay, seekBy, stepFrame, setSpeed, timed]);

  const name = basename(p.path);
  const dpr = window.devicePixelRatio || 1;
  // 等倍表示は Windows の表示倍率を打ち消して、ディスプレイの1画素に合わせる(7.9)
  const actualSize = (w: number, h: number) => (zoom === 'actual' ? { width: w / dpr, height: h / dpr } : undefined);

  return (
    <WindowFrame
      {...p}
      testId="player-window"
      name={name}
      icon={p.media === 'image' ? 'image' : p.media === 'audio' ? 'audio' : 'movie'}
      sectionRef={win}
    >
      <div
        className={`window-body ${zoom}`}
        onPointerDown={() => {
          wasOp.current = p.opMode;
        }}
        onClick={() => {
          if (timed && wasOp.current) togglePlay();
        }}
      >
        {p.media === 'image' ? (
          <ImageView path={p.path} api={imageApi} onError={fail} onReady={() => setStatus({ kind: 'ready' })} />        ) : (
          <video
            ref={video}
            playsInline
            // 先に出した失敗(映像を出せない形式など)は消さない
            onLoadedData={() => setStatus((s) => (s.kind === 'error' ? s : { kind: 'ready' }))}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            onError={() => status.kind !== 'error' && fail(ja.playFailed)}
            style={probe ? actualSize(probe.width, probe.height) : undefined}
          />
        )}
        {status.kind === 'loading' && <div className="window-overlay">{ja.loading}</div>}
        {status.kind === 'error' && (
          <div className="window-overlay error" role="alert">
            <strong>{ja.openFailed(name, '')}</strong>
            <span>{status.message}</span>
          </div>
        )}
      </div>
      {timed && (
        <Controls
          path={p.path}
          probe={probe}
          ranges={ranges}
          ab={ab}
          time={time}
          frame={frame}
          playing={playing}
          rate={rate}
          muted={muted}
          volume={volume}
          onSeek={seek}
          onSeekBy={seekBy}
          onStep={stepFrame}
          onToggle={togglePlay}
          onSpeed={setSpeed}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => {
            setVolume(v);
            setMuted(false);
          }}
          onFullscreen={() => (document.fullscreenElement ? void document.exitFullscreen() : void win.current?.requestFullscreen())}
          zoom={{ fit: zoom === 'fit', onToggle: () => setZoom((z) => (z === 'fit' ? 'actual' : 'fit')) }}
        />
      )}
    </WindowFrame>
  );
}
