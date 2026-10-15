// キャンバス上の1つのウィンドウ。動画・音声・画像を表示し、下部に再生コントロールを出す(4.2、F2、F5)
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { api, ApiError } from '../api/http';
import type { MediaKind } from '../protocol/MediaKind';
import type { Probe } from '../protocol/Probe';
import { basename, formatTime } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { frameAt, frameFrom, seekTimeFor } from './frames';
import type { Rect } from './layout';
import { TranscodeSource } from './mse';
import { SeekBar } from './SeekBar';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** キャンバスのキー操作から呼ぶ操作 */
export type PlayerApi = {
  toggle(): void;
  isPaused(): boolean;
  setPlaying(playing: boolean): void;
  seekBy(sec: number): void;
  step(dir: 1 | -1): void;
  seekFraction(f: number): void;
  speed(dir: 1 | -1): void;
  ab(): void;
  toggleMute(): void;
  toggleZoom(): void;
  fullscreen(): void;
};

type Props = {
  id: number;
  number: number;
  path: string;
  media: MediaKind;
  rect: Rect;
  focused: boolean;
  /** 音を出すか(複数あるときはフォーカス中だけ。7.6) */
  audible: boolean;
  free: boolean;
  api: Ref<PlayerApi | null>;
  onFocus: () => void;
  onClose: () => void;
  onMove: (dx: number, dy: number) => void;
  onResize: (dw: number, dh: number) => void;
};

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/** 範囲 [s, e) を秒で(読み込み済みのセグメント) */
function segmentRanges(loaded: ReadonlySet<number>, secs: number, duration: number): [number, number][] {
  return [...loaded].sort((a, b) => a - b).map((i) => [i * secs, Math.min(duration, (i + 1) * secs)]);
}

export function PlayerWindow(p: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const win = useRef<HTMLElement>(null);
  const source = useRef<TranscodeSource | null>(null);
  /**
   * 表示中のフレーム番号。requestVideoFrameCallback で更新し、自分でシークしたときは行き先をすぐ入れる
   * (シーク直後はその通知が遅れ、一時停止直後は currentTime が表示中のフレームより手前になることがあるため)
   */
  const shown = useRef(0);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [frame, setFrame] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [ranges, setRanges] = useState<[number, number][]>([]);
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
  const timed = p.media === 'video' || p.media === 'audio';
  const abRef = useRef(ab);
  useEffect(() => {
    abRef.current = ab;
  }, [ab]);

  const fail = useCallback((message: string) => setStatus({ kind: 'error', message }), []);

  // 調べてから、そのまま再生するか変換して再生するかを決める
  useEffect(() => {
    if (!timed) return;
    let alive = true;
    api.probe(p.path).then(
      (pr) => {
        if (!alive) return;
        setProbe(pr);
        const v = video.current!;
        if (pr.needsTranscode) {
          source.current = new TranscodeSource(
            v,
            p.path,
            pr,
            () => alive && setRanges(segmentRanges(source.current!.loaded, pr.segmentSecs, pr.duration)),
            (m) => alive && fail(m),
          );
        } else {
          v.src = api.mediaUrl(p.path);
        }
        void v.play().catch(() => {});
      },
      (e: unknown) => alive && fail(e instanceof ApiError ? e.message : String(e)),
    );
    return () => {
      alive = false;
      source.current?.dispose();
      source.current = null;
    };
  }, [p.path, timed, fail]);

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

  useImperativeHandle(p.api, () => ({
    toggle: () => {
      const v = video.current;
      if (v) void (v.paused ? v.play() : Promise.resolve(v.pause())).catch(() => {});
    },
    isPaused: () => video.current?.paused ?? true,
    setPlaying: (on) => {
      const v = video.current;
      if (v) void (on ? v.play() : Promise.resolve(v.pause())).catch(() => {});
    },
    seekBy: (sec) => seek((video.current?.currentTime ?? 0) + sec),
    step: (dir) => {
      const v = video.current;
      if (!v || !probe || probe.frameTimes.length === 0) return;
      v.pause();
      seek(seekTimeFor(probe.frameTimes, shown.current + dir, probe.duration));
    },
    seekFraction: (f) => {
      if (!probe) return;
      const t = probe.duration * f;
      seek(probe.frameTimes.length ? seekTimeFor(probe.frameTimes, frameFrom(probe.frameTimes, t), probe.duration) : t);
    },
    speed: (dir) => {
      const v = video.current;
      if (!v) return;
      const i = SPEEDS.indexOf(v.playbackRate);
      const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))]!;
      v.playbackRate = next;
      setRate(next);
    },
    ab: () => {
      const t = video.current?.currentTime ?? 0;
      setAb((s) => (s.a === null ? { a: t, b: null } : s.b === null ? (t > s.a ? { a: s.a, b: t } : { a: t, b: s.a }) : { a: null, b: null }));
    },
    toggleMute: () => setMuted((m) => !m),
    toggleZoom: () => setZoom((z) => (z === 'fit' ? 'actual' : 'fit')),
    fullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void win.current?.requestFullscreen();
    },
  }), [probe, seek]);

  // 自由配置ではタイトルバーで移動、右下の角で大きさを変える
  const drag = (kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!p.free || e.button !== 0) return;
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    const move = (ev: PointerEvent) => {
      (kind === 'move' ? p.onMove : p.onResize)(ev.clientX - x, ev.clientY - y);
      x = ev.clientX;
      y = ev.clientY;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const name = basename(p.path);
  const dpr = window.devicePixelRatio || 1;
  // 等倍表示は Windows の表示倍率を打ち消して、ディスプレイの1画素に合わせる(7.9)
  const actualSize = (w: number, h: number) => (zoom === 'actual' ? { width: w / dpr, height: h / dpr } : undefined);

  return (
    <section
      ref={win}
      className={`window${p.focused ? ' focused' : ''}`}
      style={{ left: p.rect.x, top: p.rect.y, width: p.rect.w, height: p.rect.h }}
      data-testid="player-window"
      aria-label={name}
      onPointerDown={p.onFocus}
    >
      <header className="window-title" onPointerDown={drag('move')}>
        <span className="window-number">{p.number}</span>
        <Icon name={p.media === 'image' ? 'image' : p.media === 'audio' ? 'audio' : 'movie'} size={18} />
        <span className="window-name">{name}</span>
        <button type="button" className="icon-button small" title={ja.close} onClick={p.onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className={`window-body ${zoom}`}>
        {p.media === 'image' ? (
          <img
            src={api.mediaUrl(p.path)}
            alt=""
            onLoad={(e) => {
              setStatus({ kind: 'ready' });
              setImageSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            }}
            onError={() => fail(ja.imageFailed)}
            style={actualSize(imageSize.w, imageSize.h)}
          />
        ) : (
          <video
            ref={video}
            playsInline
            onLoadedData={() => setStatus({ kind: 'ready' })}
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
        <footer className="controls">
          <SeekBar
            path={p.path}
            time={time}
            duration={probe?.duration ?? 0}
            sprite={probe?.sprite ?? null}
            ranges={ranges}
            ab={ab}
            onSeek={seek}
          />
          <div className="control-row">
            <button type="button" className="icon-button small" title={playing ? ja.pause : ja.play} onClick={() => video.current && (video.current.paused ? void video.current.play() : video.current.pause())}>
              <Icon name={playing ? 'pause' : 'play'} size={20} />
            </button>
            <span className="time">
              {formatTime(time)} / {formatTime(probe?.duration ?? 0)}
            </span>
            {probe && probe.frameTimes.length > 0 && (
              <span className="frame" data-testid="frame-number">
                {ja.frame(frame, probe.frameTimes.length)}
              </span>
            )}
            {ab.a !== null && <span className="chip small">{ja.abLoop(ab.a, ab.b)}</span>}
            <span className="spacer" />
            <span className="rate" title={ja.speed}>
              {rate}x
            </span>
            <button type="button" className="icon-button small" title={ja.mute} onClick={() => setMuted((m) => !m)}>
              <Icon name={muted || volume === 0 ? 'volumeOff' : 'volume'} size={20} />
            </button>
            <input
              className="volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label={ja.volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(false);
              }}
            />
            <button type="button" className="text-button" title={ja.zoom} onClick={() => setZoom((z) => (z === 'fit' ? 'actual' : 'fit'))}>
              {zoom === 'fit' ? ja.zoomFit : ja.zoomActual}
            </button>
            <button type="button" className="icon-button small" title={ja.fullscreen} onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void win.current?.requestFullscreen())}>
              <Icon name="fullscreen" size={20} />
            </button>
          </div>
        </footer>
      )}
      {p.free && <div className="resize-handle" onPointerDown={drag('resize')} />}
    </section>
  );
}
