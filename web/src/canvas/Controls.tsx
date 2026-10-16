// 再生コントロール(4.2): シークバーと、左に時刻、中央に再生ボタン群、右に速度・音量・等倍・全画面。
// 1ファイルのウィンドウと比較ウィンドウで共通
import { useEffect, useState } from 'react';
import type { Probe } from '../protocol/Probe';
import { formatTime } from '../format';
import { ja } from '../i18n/ja';
import { Icon, type IconName } from '../icons';
import { SeekBar } from './SeekBar';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];


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

type Props = {
  path: string;
  probe: Probe | null;
  /** 変換済み(読み込み済み)の範囲 */
  ranges: readonly [number, number][];
  ab: { a: number | null; b: number | null };
  time: number;
  frame: number;
  playing: boolean;
  rate: number;
  muted: boolean;
  volume: number;
  onSeek: (t: number) => void;
  onSeekBy: (sec: number) => void;
  onStep: (dir: 1 | -1) => void;
  onToggle: () => void;
  onSpeed: (r: number) => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onFullscreen: () => void;
  /** 等倍 / フィットの切替(比較ウィンドウでは出さない) */
  zoom?: { fit: boolean; onToggle: () => void };
};

export function Controls(p: Props) {
  const stepable = (p.probe?.frameTimes.length ?? 0) > 0;
  return (
    <footer className="controls">
      <SeekBar path={p.path} time={p.time} duration={p.probe?.duration ?? 0} sprite={p.probe?.sprite ?? null} ranges={p.ranges} ab={p.ab} onSeek={p.onSeek} />
      <div className="control-row">
        <div className="control-side">
          <span className="time">
            {formatTime(p.time)} / {formatTime(p.probe?.duration ?? 0)}
          </span>
          {stepable && (
            <span className="frame" data-testid="frame-number">
              {ja.frame(p.frame, p.probe!.frameTimes.length)}
            </span>
          )}
          {p.ab.a !== null && <span className="chip small">{ja.abLoop(p.ab.a, p.ab.b)}</span>}
        </div>
        <div className="transport">
          {/* コマ戻り / コマ送りは使える一時停止中だけ出す */}
          {!p.playing && stepable && <IconButton icon="frameBack" label={ja.frameBack} title={ja.frameBackKey} onClick={() => p.onStep(-1)} />}
          <SeekButton sec={5} back label={ja.back5} onClick={() => p.onSeekBy(-5)} />
          <SeekButton sec={30} back label={ja.back30} onClick={() => p.onSeekBy(-30)} />
          <button type="button" className="play-button" aria-label={p.playing ? ja.pauseLabel : ja.playLabel} title={p.playing ? ja.pause : ja.play} onClick={p.onToggle}>
            <Icon name={p.playing ? 'pauseCircle' : 'playCircle'} size={44} />
          </button>
          <SeekButton sec={30} label={ja.fwd30} onClick={() => p.onSeekBy(30)} />
          <SeekButton sec={5} label={ja.fwd5} onClick={() => p.onSeekBy(5)} />
          {!p.playing && stepable && <IconButton icon="frameNext" label={ja.frameNext} title={ja.frameNextKey} onClick={() => p.onStep(1)} />}
        </div>
        <div className="control-side end">
          <SpeedMenu rate={p.rate} onChange={p.onSpeed} />
          <button type="button" className="icon-button small" title={ja.mute} onClick={p.onMute}>
            <Icon name={p.muted || p.volume === 0 ? 'volumeOff' : 'volume'} size={20} />
          </button>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={p.muted ? 0 : p.volume}
            aria-label={ja.volume}
            onChange={(e) => p.onVolume(Number(e.target.value))}
          />
          {p.zoom && (
            <button type="button" className="text-button" title={ja.zoom} onClick={p.zoom.onToggle}>
              {p.zoom.fit ? ja.zoomFit : ja.zoomActual}
            </button>
          )}
          <button type="button" className="icon-button small" title={ja.fullscreen} aria-label={ja.fullscreen} onClick={p.onFullscreen}>
            <Icon name="fullscreen" size={20} />
          </button>
        </div>
      </div>
    </footer>
  );
}
