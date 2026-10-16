// 比較ウィンドウ(F7): 2つ以上のファイルを1つのウィンドウで比べる。
// 並べる(同期再生)/ スライダー(1つ目と2つ目を重ね、境目より右に2つ目)/ 差分(1つ目と2つ目の差)。
// 表示を切り替えても動画を読み込み直さないよう、要素は同じまま配置だけを変える
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { api } from '../api/http';
import type { MediaKind } from '../protocol/MediaKind';
import type { Probe } from '../protocol/Probe';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { frameAt, frameFrom, seekTimeFor } from './frames';
import type { Rect } from './layout';
import type { PlayerApi } from './PlayerWindow';
import { Controls, SPEEDS } from './Controls';
import { useVideoSource } from './source';
import { SyncGroup } from './sync';
import { WindowFrame, type FrameProps } from './WindowFrame';

export type CompareMode = 'side' | 'slider' | 'diff';
export const COMPARE_MODES: CompareMode[] = ['side', 'slider', 'diff'];
export type Member = { path: string; media: MediaKind };

type Props = FrameProps & {
  members: Member[];
  audible: boolean;
  api: Ref<PlayerApi | null>;
  onError: (m: string) => void;
};

/** `w`×`h` の中に、縦横比 `aspect` を保って収まる中央の矩形 */
function fit(x: number, y: number, w: number, h: number, aspect: number): Rect {
  if (!(aspect > 0)) return { x, y, w, h };
  const width = Math.min(w, h * aspect);
  const height = width / aspect;
  return { x: x + (w - width) / 2, y: y + (h - height) / 2, w: width, h: height };
}

/** 1つのファイル(動画なら読み込みも行う) */
function MemberMedia(p: {
  index: number;
  member: Member;
  rect: Rect | null;
  blend: boolean;
  clip: number | null;
  /** ファイル名のラベルを出すか(並べる表示だけ) */
  label: boolean;
  muted: boolean;
  volume: number;
  onVideo: (index: number, v: HTMLVideoElement | null) => void;
  onProbe: (pr: Probe) => void;
  onSize: (aspect: number) => void;
  onError: (m: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const isVideo = p.member.media === 'video';
  useVideoSource(video, p.member.path, isVideo, { onProbe: p.onProbe, onError: p.onError });
  const { onVideo, index } = p;
  useEffect(() => {
    onVideo(index, video.current);
    return () => onVideo(index, null);
  }, [onVideo, index]);
  useEffect(() => {
    if (video.current) {
      video.current.muted = p.muted;
      video.current.volume = p.volume;
    }
  }, [p.muted, p.volume]);

  const style: React.CSSProperties = p.rect
    ? {
        left: p.rect.x,
        top: p.rect.y,
        width: p.rect.w,
        height: p.rect.h,
        mixBlendMode: p.blend ? 'difference' : undefined,
        // スライダー: 境目より右だけを見せる
        clipPath: p.clip !== null ? `inset(0 0 0 ${p.clip * 100}%)` : undefined,
      }
    : { display: 'none' };
  return (
    <div className="cmp-layer" style={style}>
      {isVideo ? (
        <video ref={video} playsInline muted onLoadedMetadata={(e) => p.onSize(e.currentTarget.videoWidth / e.currentTarget.videoHeight)} />
      ) : (
        <img src={api.mediaUrl(p.member.path)} alt="" draggable={false} onLoad={(e) => p.onSize(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
      )}
      {p.label && <span className="cmp-label">{basename(p.member.path)}</span>}
    </div>
  );
}

export function CompareWindow({ api: apiRef, ...p }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLElement>(null);
  const videos = useRef(new Map<number, HTMLVideoElement>());
  const [videoCount, setVideoCount] = useState(0);
  const [mode, setMode] = useState<CompareMode>('side');
  const [split, setSplit] = useState(0.5);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [aspects, setAspects] = useState<number[]>([]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [frame, setFrame] = useState(0);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const abRef = useRef(ab);
  useEffect(() => {
    abRef.current = ab;
  }, [ab]);
  const hasVideo = p.members.some((m) => m.media === 'video');
  const n = p.members.length;

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const master = () => videos.current.get(0) ?? null;

  // 中の動画は常に同期させる(1つ目が基準)
  useEffect(() => {
    const m = videos.current.get(0);
    if (!m) return;
    const followers = [...videos.current].filter(([i]) => i !== 0).map(([, v]) => v);
    if (followers.length === 0) return;
    const group = new SyncGroup(m, followers);
    group.start();
    return () => group.stop();
  }, [videoCount]);

  // 1つ目の動画で時刻とフレーム番号を出す
  useEffect(() => {
    const v = videos.current.get(0);
    if (!v || !probe) return;
    let handle = 0;
    const onFrame: VideoFrameRequestCallback = (_, meta) => {
      setFrame(frameAt(probe.frameTimes, meta.mediaTime));
      setTime(meta.mediaTime);
      // A-B ループ(ほかの動画は同期でついてくる)
      const { a, b } = abRef.current;
      if (a !== null && b !== null && meta.mediaTime >= b) v.currentTime = a;
      handle = v.requestVideoFrameCallback(onFrame);
    };
    handle = v.requestVideoFrameCallback(onFrame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    setPlaying(!v.paused);
    return () => {
      v.cancelVideoFrameCallback(handle);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [probe, videoCount]);

  const registerVideo = useCallback((i: number, v: HTMLVideoElement | null) => {
    if (v) videos.current.set(i, v);
    else videos.current.delete(i);
    setVideoCount(videos.current.size);
  }, []);
  const onFirstProbe = useCallback((pr: Probe) => setProbe(pr), []);
  const noProbe = useCallback(() => {}, []);

  const seek = useCallback((t: number) => {
    const v = videos.current.get(0);
    if (v) v.currentTime = Math.max(0, Math.min(probe?.duration ?? t, t));
  }, [probe]);
  const togglePlay = useCallback(() => {
    const v = videos.current.get(0);
    if (v) void (v.paused ? v.play() : Promise.resolve(v.pause())).catch(() => {});
  }, []);
  const seekBy = useCallback((sec: number) => seek((videos.current.get(0)?.currentTime ?? 0) + sec), [seek]);
  const step = useCallback(
    (dir: 1 | -1) => {
      const v = videos.current.get(0);
      if (!v || !probe?.frameTimes.length) return;
      v.pause();
      seek(seekTimeFor(probe.frameTimes, frameAt(probe.frameTimes, v.currentTime) + dir, probe.duration));
    },
    [probe, seek],
  );
  const setSpeed = useCallback((r: number) => {
    const v = videos.current.get(0);
    if (v) {
      v.defaultPlaybackRate = r;
      v.playbackRate = r;
    }
    setRate(r);
  }, []);
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void win.current?.requestFullscreen();
  }, []);
  const cycleMode = useCallback(() => setMode((m) => COMPARE_MODES[(COMPARE_MODES.indexOf(m) + 1) % COMPARE_MODES.length]!), []);

  useImperativeHandle(apiRef, () => ({
    toggle: togglePlay,
    isPaused: () => master()?.paused ?? true,
    video: () => master(),
    setPlaying: (on) => {
      const v = master();
      if (v) void (on ? v.play() : Promise.resolve(v.pause())).catch(() => {});
    },
    seekBy,
    step,
    seekFraction: (f) => {
      if (!probe) return;
      const t = probe.duration * f;
      seek(probe.frameTimes.length ? seekTimeFor(probe.frameTimes, frameFrom(probe.frameTimes, t), probe.duration) : t);
    },
    speed: (dir) => {
      const i = SPEEDS.indexOf(rate);
      setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))]!);
    },
    ab: () => {
      const t = master()?.currentTime ?? 0;
      setAb((s) => (s.a === null ? { a: t, b: null } : s.b === null ? (t > s.a ? { a: s.a, b: t } : { a: t, b: s.a }) : { a: null, b: null }));
    },
    toggleMute: () => setMuted((m) => !m),
    toggleZoom: () => {},
    fullscreen,
    cycleMode,
  }), [togglePlay, seek, probe, cycleMode, seekBy, step, rate, setSpeed, fullscreen]);

  // 各ファイルの配置
  const aspectOf = (i: number) => aspects[i] ?? aspects[0] ?? 16 / 9;
  const pair = fit(0, 0, size.w, size.h, aspectOf(0));
  const rects: (Rect | null)[] = p.members.map((_, i) => {
    if (mode !== 'side') return i < 2 ? pair : null;
    const cols = n <= 2 ? n : Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = size.w / cols;
    const ch = size.h / rows;
    return fit((i % cols) * cw, Math.floor(i / cols) * ch, cw, ch, aspectOf(i));
  });

  // スライダーの境目のドラッグ
  const dragHandle = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = stage.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.max(0, Math.min(1, (ev.clientX - box.left - pair.x) / pair.w)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const names = p.members.map((m) => basename(m.path));
  return (
    <WindowFrame {...p} testId="compare-window" name={ja.compareTitle(names)} icon="compare" sectionRef={win}>
      <div className="cmp-toolbar">
        <div className="segmented" role="radiogroup" aria-label={ja.compareMode}>
          {COMPARE_MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {ja.compareModes[m]}
            </button>
          ))}
        </div>
        {mode !== 'side' && n > 2 && <span className="muted">{ja.comparePair(names[0]!, names[1]!)}</span>}
      </div>
      <div ref={stage} className={`cmp-stage ${mode}`} data-testid="compare-stage" onDoubleClick={togglePlay}>
        {p.members.map((m, i) => (
          <MemberMedia
            key={m.path + i}
            member={m}
            rect={rects[i] ?? null}
            blend={mode === 'diff' && i === 1}
            clip={mode === 'slider' && i === 1 ? split : null}
            label={mode === 'side'}
            muted={i !== 0 || muted || !p.audible}
            volume={volume}
            index={i}
            onVideo={registerVideo}
            onProbe={i === 0 ? onFirstProbe : noProbe}
            onSize={(a) => setAspects((s) => Object.assign([...s], { [i]: a }))}
            onError={p.onError}
          />
        ))}
        {mode !== 'side' && (
          <div className="cmp-media" data-testid="compare-media" style={{ left: pair.x, top: pair.y, width: pair.w, height: pair.h }}>
            {mode === 'slider' && (
              <div className="cmp-handle" data-testid="compare-handle" style={{ left: `${split * 100}%` }} onPointerDown={dragHandle}>
                <span className="cmp-knob" />
              </div>
            )}
          </div>
        )}
      </div>
      {hasVideo && (
        <Controls
          path={p.members[0]!.path}
          probe={probe}
          ranges={[]}
          ab={ab}
          time={time}
          frame={frame}
          playing={playing}
          rate={rate}
          muted={muted}
          volume={volume}
          onSeek={seek}
          onSeekBy={seekBy}
          onStep={step}
          onToggle={togglePlay}
          onSpeed={setSpeed}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => {
            setVolume(v);
            setMuted(false);
          }}
          onFullscreen={fullscreen}
        />
      )}
    </WindowFrame>
  );
}
