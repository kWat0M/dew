// ディレクトリの中身の一覧(リスト / グリッド)。1万件でも固まらないよう、見えている範囲だけ描く(7.3)
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Entry } from '../protocol/Entry';
import { Icon, type IconName } from '../icons';
import { api } from '../api/http';
import { join } from '../format';
import { ja } from '../i18n/ja';

const ROW_HEIGHT = 36;
const TILE = { width: 168, height: 148 };
const OVERSCAN = 4;

export type View = 'list' | 'grid';

type Props = {
  testId: string;
  label: string;
  dir: string;
  entries: Entry[];
  selected: number;
  view: View;
  /** 新規・更新のバッジを付ける名前 */
  changed?: ReadonlySet<string>;
  /** Space で選んだ名前 */
  marked?: ReadonlySet<string>;
  /** サムネイルを出すか(親カラムでは出さない) */
  thumbs?: boolean;
  onClick?: (index: number) => void;
  onDoubleClick?: (index: number) => void;
  empty?: ReactNode;
};

export function iconFor(e: Entry): IconName {
  if (!e.readable) return 'lock';
  if (e.kind === 'dir') return 'folder';
  return ({ image: 'image', video: 'movie', audio: 'audio', other: 'file' } as const)[e.media];
}

/** サムネイル。作れなかったら(壊れたファイルなど)アイコンを出す */
export function Thumb({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return fallback;
  return <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} />;
}

export function EntryList(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [size, setSize] = useState({ width: 600, height: 600 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth || 600, height: el.clientHeight || 600 });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const grid = p.view === 'grid';
  const cols = grid ? Math.max(1, Math.floor(size.width / TILE.width)) : 1;
  const rowH = grid ? TILE.height : ROW_HEIGHT;
  const rows = Math.ceil(p.entries.length / cols);
  const first = Math.max(0, Math.floor(scroll / rowH) - OVERSCAN);
  const last = Math.min(rows, Math.ceil((scroll + size.height) / rowH) + OVERSCAN);

  // 選択中の項目が見えるようにスクロールする
  useEffect(() => {
    const el = box.current;
    if (!el || p.selected < 0) return;
    const top = Math.floor(p.selected / cols) * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  }, [p.selected, cols, rowH]);

  const items = [];
  for (let i = first * cols; i < Math.min(p.entries.length, last * cols); i++) {
    const e = p.entries[i]!;
    const row = Math.floor(i / cols);
    const col = i % cols;
    const style = grid
      ? { top: row * rowH, left: col * TILE.width, width: TILE.width, height: rowH }
      : { top: row * rowH, left: 0, right: 0, height: rowH };
    const thumb = p.thumbs && e.readable && e.kind === 'file' && (e.media === 'image' || e.media === 'video');
    items.push(
      <div
        key={e.name}
        role="option"
        aria-selected={i === p.selected}
        data-name={e.name}
        className={`entry${i === p.selected ? ' selected' : ''}${p.marked?.has(e.name) ? ' marked' : ''}${e.readable ? '' : ' unreadable'}`}
        style={style}
        onClick={() => p.onClick?.(i)}
        onDoubleClick={() => p.onDoubleClick?.(i)}
      >
        <span className="entry-icon">
          {thumb ? (
            <Thumb src={api.thumbUrl(join(p.dir, e.name), e.mtime)} fallback={<Icon name={iconFor(e)} size={grid ? 48 : 20} />} />
          ) : (
            <Icon name={iconFor(e)} size={grid ? 48 : 20} />
          )}
        </span>
        <span className="entry-name">{e.name}</span>
        {p.changed?.has(e.name) && <span className="badge" title={ja.changed} />}
      </div>,
    );
  }

  return (
    <div
      ref={box}
      className={`entry-list ${p.view}`}
      role="listbox"
      aria-label={p.label}
      data-testid={p.testId}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
    >
      {p.entries.length === 0 ? (
        <div className="entry-empty">{p.empty}</div>
      ) : (
        <div className="entry-spacer" style={{ height: rows * rowH }}>
          {items}
        </div>
      )}
    </div>
  );
}
