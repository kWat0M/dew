// 選択欄(MD3 の Exposed dropdown menu)。ブラウザ標準の select は hjkl で選べないので自前で作る。
// 欄で Enter(またはクリック)で一覧を開き、j / k・↑ / ↓ で選んで Enter で決める。Esc・Ctrl+[・q で閉じる(選び直さない)
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { isLeaveKey, readKey } from '../keys';
import './MenuSelect.css';

const MAX_HEIGHT = 280;

export type MenuOption<T> = { value: T; label: string; className?: string };

type Props<T> = {
  label: string;
  value: T;
  options: MenuOption<T>[];
  onChange: (v: T) => void;
  className?: string;
};

export function MenuSelect<T extends string | number>({ label, value, options, onChange, className }: Props<T>) {
  /** 開いている一覧の位置(スクロールする画面の中でも切れないよう、画面に対して置く) */
  const [open, setOpen] = useState<React.CSSProperties | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);

  // 一覧の外を押したら閉じる
  useEffect(() => {
    if (!open) return;
    const f = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', f, { capture: true });
    return () => window.removeEventListener('pointerdown', f, { capture: true });
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const r = trigger.current!.getBoundingClientRect();
    // 下に入りきらなければ上に出す
    const below = window.innerHeight - r.bottom;
    setOpen(below >= Math.min(MAX_HEIGHT, options.length * 40 + 16) || below >= r.top ? { top: r.bottom + 4, left: r.left, minWidth: r.width, maxHeight: Math.min(MAX_HEIGHT, below - 8) } : { bottom: window.innerHeight - r.top + 4, left: r.left, minWidth: r.width, maxHeight: Math.min(MAX_HEIGHT, r.top - 8) });
  };
  const pick = (i: number) => {
    setOpen(null);
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    trigger.current?.focus();
  };

  return (
    <div ref={box} className="menu-select">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open !== null}
        aria-haspopup="listbox"
        data-nav=""
        data-keep-focus=""
        className={`menu-select-field${className ? ` ${className}` : ''}`}
        onClick={() => (open ? setOpen(null) : show())}
        onKeyDown={(e) => {
          const k = readKey(e.nativeEvent);
          if (!k) return;
          if (!open) {
            if (k.key !== 'Enter' && k.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            return show();
          }
          // 一覧を開いている間のキーは、ここで受け持つ(外の画面の hjkl や Esc に渡さない)
          e.preventDefault();
          e.stopPropagation();
          if (k.key === 'j' || k.key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
          else if (k.key === 'k' || k.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (k.key === 'g' || k.key === 'Home') setActive(0);
          else if (k.key === 'G' || k.key === 'End') setActive(options.length - 1);
          else if (k.key === 'Enter' || k.key === ' ') pick(active);
          else if (isLeaveKey(k.key)) setOpen(null);
        }}
      >
        <span className="menu-select-value">{current?.label ?? ''}</span>
        <Icon name="dropDown" size={20} />
      </button>
      {open && (
        <ul className="menu-select-list" role="listbox" aria-label={label} style={open}>
          {options.map((o, i) => (
            <li
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              data-value={String(o.value)}
              data-active={i === active}
              className={`menu-select-item${o.className ? ` ${o.className}` : ''}`}
              ref={(el) => {
                if (i === active) el?.scrollIntoView({ block: 'nearest' });
              }}
              // 押しても欄からフォーカスを外さない(続けてキーで操作できるように)
              onPointerDown={(e) => e.preventDefault()}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
