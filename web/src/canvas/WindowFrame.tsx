// キャンバス上のウィンドウの枠: タイトルバー(選択、番号、名前、最小化・最大化・閉じる)、ドラッグ、大きさの変更。
// 1ファイルのウィンドウと比較ウィンドウで共通
import type { ReactNode, Ref } from 'react';
import { ja } from '../i18n/ja';
import { Icon, type IconName } from '../icons';
import type { Rect } from './layout';

/** キャンバスが渡す、配置と枠の操作 */
export type FrameProps = {
  number: number;
  rect: Rect;
  focused: boolean;
  /** 複数選択に入っているか */
  selected: boolean;
  maximized: boolean;
  /** 最小化中(配置から外し、タスクバーにだけ残す) */
  minimized: boolean;
  /** タイルの並べ替えで、落とす先になっている */
  dropTarget: boolean;
  /** 自由配置(タイトルバーで移動、右下の角で大きさを変える) */
  free: boolean;
  onFocus: () => void;
  onClose: () => void;
  onToggleSelect: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  /** タイル配置でタイトルバーのドラッグを始めた(並べ替えはキャンバスが行う) */
  onReorderStart: (e: React.PointerEvent) => void;
  onMove: (dx: number, dy: number) => void;
  onResize: (dw: number, dh: number) => void;
};

type Props = FrameProps & {
  testId: string;
  name: string;
  icon: IconName;
  sectionRef?: Ref<HTMLElement>;
  /** 最小化ボタンの左に足すボタン(ライブウィンドウの入力モードなど) */
  titleButtons?: ReactNode;
  children: ReactNode;
};

export function WindowFrame({ sectionRef, ...p }: Props) {
  // 自由配置ではタイトルバーで移動、右下の角で大きさを変える
  const drag = (kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!p.free) {
      if (kind === 'move' && !p.maximized) p.onReorderStart(e);
      return;
    }
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
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <section
      ref={sectionRef}
      className={`window${p.focused ? ' focused' : ''}${p.selected ? ' selected' : ''}${p.maximized ? ' maximized' : ''}${p.dropTarget ? ' drop-target' : ''}`}
      style={{ left: p.rect.x, top: p.rect.y, width: p.rect.w, height: p.rect.h }}
      hidden={p.minimized}
      data-testid={p.testId}
      data-focused={p.focused}
      data-selected={p.selected}
      aria-label={p.name}
      onPointerDown={p.onFocus}
    >
      <header className="window-title" data-testid="window-title" onPointerDown={drag('move')} onDoubleClick={p.onToggleMaximize}>
        {/* ボタンを押したときはドラッグを始めない */}
        <span className="title-controls" onPointerDown={stop} onDoubleClick={stop}>
          <input type="checkbox" className="checkbox" checked={p.selected} aria-label={ja.select} onChange={p.onToggleSelect} />
        </span>
        <span className="window-number">{p.number}</span>
        <Icon name={p.icon} size={18} />
        <span className="window-name">{p.name}</span>
        <span className="title-controls" onPointerDown={stop} onDoubleClick={stop}>
          {p.titleButtons}
          <button type="button" className="icon-button small" title={ja.minimize} aria-label={ja.minimize} onClick={p.onMinimize}>
            <Icon name="minimize" size={18} />
          </button>
          <button
            type="button"
            className="icon-button small"
            title={p.maximized ? ja.restore : ja.maximize}
            aria-label={p.maximized ? ja.restore : ja.maximize}
            onClick={p.onToggleMaximize}
          >
            <Icon name={p.maximized ? 'restore' : 'maximize'} size={18} />
          </button>
          <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onClick={p.onClose}>
            <Icon name="close" size={18} />
          </button>
        </span>
      </header>
      {p.children}
      {p.free && <div className="resize-handle" onPointerDown={drag('resize')} />}
    </section>
  );
}
