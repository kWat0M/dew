// キャンバス上の1つのウィンドウ。動画・音声・画像を表示し、下部に再生コントロールを出す(4.2、F2、F5)
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MediaKind } from '../protocol/MediaKind';
import type { Probe } from '../protocol/Probe';
import { basename, formatTime } from '../format';
import { ja } from '../i18n/ja';
import { Icon, type IconName } from '../icons';
import { frameAt, frameFrom, seekTimeFor } from './frames';
import { ImageView, type ImageApi } from './ImageView';
import { SeekBar } from './SeekBar';
import { useVideoSource } from './source';
import { WindowFrame, type FrameProps } from './WindowFrame';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

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
};

type Props = FrameProps & {
  id: number;
  path: string;
  media: MediaKind;
  /** 音を出すか(複数あるときはフォーカス中だけ。7.6) */
  audible: boolean;
  api: Ref<PlayerApi | null>;
};

/** 再生開始からミュート解除ボタンを出しておく時間 */
const UNMUTE_HINT_MS = 5000;

function IconButton({ icon, label, title, size = 22, onClick }: { icon: IconName; label: string; title: string; size?: number; onClick: () => void }) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={title} onClick={onClick}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/** 5秒 / 30秒の戻り・送り(Material Symbols の replay_5 などを使う) */
function SeekButton({ sec, back, label, onClick }: { sec: 5 | 30; back?: boolean; label: string; onClick: () => void }) {
  const icon: IconName = back ? (sec === 5 ? 'back5' : 'back30') : sec === 5 ? 'fwd5' : 'fwd30';
  return <IconButton icon={icon} label={label} title={label} size={26} onClick={onClick} />;
}

/** 再生速度の表示。押すと速度の一覧を出す */
function SpeedMenu({ rate, onChange }: { rate: number; onChange: (r: number) => void }) {
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [at]);
  return (
    <>
      <button
        type="button"
        className="rate-button"
        aria-label={ja.speedLabel}
        aria-haspopup="menu"
        title={ja.speed}
        onClick={(e) => {
          // ウィンドウの外にはみ出しても切れないよう、画面に対して位置を決める
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { left: r.left + r.width / 2, bottom: window.innerHeight - r.top + 4 });
        }}
      >
        {rate}x
      </button>
      {at && (
        <div className="menu" role="menu" aria-label={ja.speedLabel} style={{ left: at.left, bottom: at.bottom }} onPointerDown={(e) => e.stopPropagation()}>
          {[...SPEEDS].reverse().map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === rate}
              className="menu-item"
              onClick={() => {
                onChange(s);
                setAt(null);
              }}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
    </>
  );
}

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
  /** 音声のある動画をミュートで始めたときに出す、大きめのミュート解除ボタン(7.6) */
  const [showUnmute, setShowUnmute] = useState(false);
  const unmuteTimer = useRef<number | null>(null);
  /** 本体を押し始めたときにフォーカス中だったか(クリックで再生 / 停止するのはフォーカス中だけ) */
  const wasFocused = useRef(false);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const imageApi = useRef<ImageApi | null>(null);
  const timed = p.media === 'video' || p.media === 'audio';
  const abRef = useRef(ab);
  useEffect(() => {
    abRef.current = ab;
  }, [ab]);

  const fail = useCallback((message: string) => setStatus({ kind: 'error', message }), []);

  // 複数を一度に開いても音が重ならないよう、音声のある動画はミュートで始める(7.6)
  const onProbe = useCallback((pr: Probe) => {
    if (pr.audioCodec) {
      setMuted(true);
      setShowUnmute(true);
    }
  }, []);
  const { probe, ranges } = useVideoSource(video, p.path, timed, { onProbe, onError: fail });
  useEffect(
    () => () => {
      if (unmuteTimer.current !== null) clearTimeout(unmuteTimer.current);
    },
    [],
  );

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
  const stepable = (probe?.frameTimes.length ?? 0) > 0;
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
          wasFocused.current = p.focused;
        }}
        onClick={() => {
          if (timed && wasFocused.current) togglePlay();
        }}
      >
        {p.media === 'image' ? (
          <ImageView path={p.path} api={imageApi} onError={fail} onReady={() => setStatus({ kind: 'ready' })} />        ) : (
          <video
            ref={video}
            playsInline
            onLoadedData={() => setStatus({ kind: 'ready' })}
            onPlay={() => setPlaying(true)}
            onPlaying={() => {
              // 再生が始まってから約5秒でミュート解除ボタンを消す
              if (unmuteTimer.current === null) unmuteTimer.current = window.setTimeout(() => setShowUnmute(false), UNMUTE_HINT_MS);
            }}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            onError={() => status.kind !== 'error' && fail(ja.playFailed)}
            style={probe ? actualSize(probe.width, probe.height) : undefined}
          />
        )}
        {showUnmute && muted && (
          <button
            type="button"
            className="unmute-button"
            aria-label={ja.unmute}
            onClick={(e) => {
              e.stopPropagation();
              setMuted(false);
              setShowUnmute(false);
            }}
          >
            <Icon name="volumeOff" size={22} />
            {ja.unmute}
          </button>
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
            <div className="control-side">
              <span className="time">
                {formatTime(time)} / {formatTime(probe?.duration ?? 0)}
              </span>
              {probe && probe.frameTimes.length > 0 && (
                <span className="frame" data-testid="frame-number">
                  {ja.frame(frame, probe.frameTimes.length)}
                </span>
              )}
              {ab.a !== null && <span className="chip small">{ja.abLoop(ab.a, ab.b)}</span>}
            </div>
            <div className="transport">
              {/* コマ戻り / コマ送りは使える一時停止中だけ出す */}
              {!playing && stepable && <IconButton icon="frameBack" label={ja.frameBack} title={ja.frameBackKey} onClick={() => stepFrame(-1)} />}
              <SeekButton sec={5} back label={ja.back5} onClick={() => seekBy(-5)} />
              <SeekButton sec={30} back label={ja.back30} onClick={() => seekBy(-30)} />
              <button
                type="button"
                className="play-button"
                aria-label={playing ? ja.pauseLabel : ja.playLabel}
                title={playing ? ja.pause : ja.play}
                onClick={togglePlay}
              >
                <Icon name={playing ? 'pauseCircle' : 'playCircle'} size={44} />
              </button>
              <SeekButton sec={30} label={ja.fwd30} onClick={() => seekBy(30)} />
              <SeekButton sec={5} label={ja.fwd5} onClick={() => seekBy(5)} />
              {!playing && stepable && <IconButton icon="frameNext" label={ja.frameNext} title={ja.frameNextKey} onClick={() => stepFrame(1)} />}
            </div>
            <div className="control-side end">
            <SpeedMenu rate={rate} onChange={setSpeed} />
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
          </div>
        </footer>
      )}
    </WindowFrame>
  );
}
