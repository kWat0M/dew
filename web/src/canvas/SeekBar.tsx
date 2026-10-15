// YouTube 風のシークバー(F5)。ホバーでスプライトのサムネイルと時刻を出す。変換済みの範囲を薄く表示する
import { useRef, useState } from 'react';
import { api } from '../api/http';
import type { Sprite } from '../protocol/Sprite';
import { formatTime } from '../format';

type Props = {
  path: string;
  time: number;
  duration: number;
  sprite: Sprite | null;
  /** 変換済み(読み込み済み)の範囲。直接再生なら空 */
  ranges: readonly [number, number][];
  ab: { a: number | null; b: number | null };
  onSeek: (t: number) => void;
};

export function SeekBar(p: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const pct = (t: number) => `${p.duration > 0 ? (Math.min(t, p.duration) / p.duration) * 100 : 0}%`;

  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * p.duration;
  };

  const sp = p.sprite;
  const tile = sp && hover !== null ? Math.min(sp.count - 1, Math.floor(hover / sp.interval)) : 0;

  return (
    <div
      ref={bar}
      className="seekbar"
      role="slider"
      aria-valuemin={0}
      aria-valuemax={p.duration}
      aria-valuenow={p.time}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        p.onSeek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        const t = timeAt(e.clientX);
        setHover(t);
        if (dragging) p.onSeek(t);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerLeave={() => !dragging && setHover(null)}
    >
      <div className="seek-track">
        {p.ranges.map(([s, e]) => (
          <div key={s} className="seek-range" style={{ left: pct(s), width: `calc(${pct(e)} - ${pct(s)})` }} />
        ))}
        <div className="seek-progress" style={{ width: pct(p.time) }} />
        {p.ab.a !== null && <div className="seek-mark" style={{ left: pct(p.ab.a) }} />}
        {p.ab.b !== null && <div className="seek-mark" style={{ left: pct(p.ab.b) }} />}
      </div>
      <div className="seek-thumb" style={{ left: pct(p.time) }} />
      {hover !== null && (
        <div className="seek-hover" style={{ left: pct(hover) }}>
          {sp && (
            <div
              className="seek-sprite"
              style={{
                width: sp.tileWidth,
                height: sp.tileHeight,
                backgroundImage: `url(${api.spriteUrl(p.path)})`,
                backgroundPosition: `-${(tile % sp.cols) * sp.tileWidth}px -${Math.floor(tile / sp.cols) * sp.tileHeight}px`,
              }}
            />
          )}
          <span>{formatTime(hover)}</span>
        </div>
      )}
    </div>
  );
}
