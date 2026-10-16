// キャンバス: 開いたファイルをフローティングウィンドウとして並べる(4.2、5.3、5.4)
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MediaKind } from '../protocol/MediaKind';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { KeySequence } from '../keys';
import { useKeys } from '../useKeys';
import { cascade, neighbor, tile, type Dir, type Rect } from './layout';
import { PlayerWindow, type PlayerApi } from './PlayerWindow';
import './Canvas.css';

export type Win = { id: number; path: string; media: MediaKind };

/** 再生のキー(選択中のウィンドウ、なければフォーカス中のウィンドウに効く) */
type PlayAction =
  | { do: 'toggle' } | { do: 'seek'; sec: number } | { do: 'step'; dir: 1 | -1 } | { do: 'percent'; n: number }
  | { do: 'speed'; dir: 1 | -1 } | { do: 'ab' } | { do: 'mute' } | { do: 'zoom' };

type NormalAction =
  | PlayAction
  | { do: 'maximize' } | { do: 'all' } | { do: 'home' } | { do: 'homeInitial' } | { do: 'help' } | { do: 'history' }
  | { do: 'windowMode' } | { do: 'escape' };

/** ウィンドウ操作モードのキー */
export type WindowAction =
  | { do: 'focusN'; n: number } | { do: 'focusDir'; dir: Dir } | { do: 'moveDir'; dir: Dir }
  | { do: 'select' } | { do: 'selectAll' } | { do: 'grow'; f: number } | { do: 'equalize' } | { do: 'layout' }
  | { do: 'minimize' } | { do: 'maximize' } | { do: 'only' } | { do: 'close' } | { do: 'closeAll' } | { do: 'exit' };

const normal: Record<string, NormalAction> = {
  k: { do: 'toggle' }, ' ': { do: 'toggle' },
  j: { do: 'seek', sec: -5 }, l: { do: 'seek', sec: 5 }, ArrowLeft: { do: 'seek', sec: -5 }, ArrowRight: { do: 'seek', sec: 5 },
  J: { do: 'seek', sec: -30 }, L: { do: 'seek', sec: 30 },
  ',': { do: 'step', dir: -1 }, '.': { do: 'step', dir: 1 },
  '[': { do: 'speed', dir: -1 }, ']': { do: 'speed', dir: 1 },
  b: { do: 'ab' }, m: { do: 'mute' }, z: { do: 'zoom' }, f: { do: 'maximize' }, K: { do: 'all' },
  h: { do: 'home' }, H: { do: 'homeInitial' }, Tab: { do: 'home' }, '?': { do: 'help' },
  w: { do: 'windowMode' }, r: { do: 'history' }, Escape: { do: 'escape' },
};
for (let n = 0; n <= 9; n++) normal[String(n)] = { do: 'percent', n };

export const windowKeys: Record<string, WindowAction> = {
  h: { do: 'focusDir', dir: 'h' }, j: { do: 'focusDir', dir: 'j' }, k: { do: 'focusDir', dir: 'k' }, l: { do: 'focusDir', dir: 'l' },
  H: { do: 'moveDir', dir: 'h' }, J: { do: 'moveDir', dir: 'j' }, K: { do: 'moveDir', dir: 'k' }, L: { do: 'moveDir', dir: 'l' },
  ' ': { do: 'select' }, a: { do: 'selectAll' },
  '+': { do: 'grow', f: 1.1 }, '-': { do: 'grow', f: 1 / 1.1 }, '=': { do: 'equalize' }, t: { do: 'layout' },
  m: { do: 'minimize' }, f: { do: 'maximize' }, o: { do: 'only' }, x: { do: 'close' }, X: { do: 'closeAll' },
  q: { do: 'exit' }, Escape: { do: 'exit' },
};
for (let n = 1; n <= 9; n++) windowKeys[String(n)] = { do: 'focusN', n };

const normalMap = new KeySequence(normal);

/** which-key 風の候補表示に出す行(キー、説明) */
const windowHelp: [string, string][] = [
  ['1–9', ja.wFocusN], ['h/j/k/l', ja.wFocusDir], ['H/J/K/L', ja.wMoveDir], ['Space', ja.wSelect], ['a', ja.wSelectAll],
  ['+ / -', `${ja.wGrow} / ${ja.wShrink}`], ['=', ja.wEqualize], ['t', ja.wLayout], ['m', ja.minimize], ['f', ja.wMaximize],
  ['o', ja.wOnly], ['x', ja.wClose], ['X', ja.wCloseAll], ['q', ja.windowModeExit],
];

type Props = {
  active: boolean;
  /** 画面に出ているか。隠れている間は音を出さない */
  visible: boolean;
  windows: Win[];
  focused: number | null;
  onFocus: (id: number | null) => void;
  onClose: (ids: number[]) => void;
  onReorder: (ids: number[]) => void;
  onHome: () => void;
  onHomeInitial: () => void;
  onHistory: () => void;
};

export function Canvas(p: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  const [mode, setMode] = useState<'tile' | 'free'>('tile');
  const [free, setFree] = useState(new Map<number, Rect>());
  const [maximized, setMaximized] = useState<number | null>(null);
  const [minimized, setMinimized] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [windowMode, setWindowMode] = useState(false);
  const [help, setHelp] = useState(false);
  /** タイル配置でドラッグ中のウィンドウと、落とす先の番号 */
  const [reorder, setReorder] = useState<{ id: number; target: number | null } | null>(null);
  const apis = useRef(new Map<number, PlayerApi | null>());

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ws = p.windows;
  // 閉じたウィンドウの状態を捨てる
  const ids = ws.map((w) => w.id).join(',');
  const [lastIds, setLastIds] = useState(ids);
  if (ids !== lastIds) {
    setLastIds(ids);
    const alive = (s: Set<number>) => new Set([...s].filter((id) => ws.some((w) => w.id === id)));
    setSelected(alive);
    setMinimized(alive);
    if (maximized !== null && !ws.some((w) => w.id === maximized)) setMaximized(null);
  }

  const shown = ws.filter((w) => !minimized.has(w.id));
  const tiles = tile(shown.length, size.w, size.h);
  const full: Rect = { x: 0, y: 0, w: size.w, h: size.h };
  const rectOf = new Map<number, Rect>();
  shown.forEach((w, i) => {
    if (shown.length === 1 || maximized === w.id) rectOf.set(w.id, full);
    else if (mode === 'free') rectOf.set(w.id, free.get(w.id) ?? cascade(i, size.w, size.h));
    else rectOf.set(w.id, tiles[i]!);
  });
  const shownRects = shown.map((w) => rectOf.get(w.id)!);
  const shownIndex = shown.findIndex((w) => w.id === p.focused);

  /** 再生のキーの対象: 選択中があればそれら、なければフォーカス中 */
  const targets = (): PlayerApi[] => {
    const idsToUse = selected.size ? [...selected] : p.focused !== null ? [p.focused] : [];
    return idsToUse.map((id) => apis.current.get(id)).filter((x): x is PlayerApi => !!x);
  };

  const focus = (id: number) => {
    setMinimized((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    p.onFocus(id);
  };

  const minimize = (id: number) => {
    setMinimized((s) => new Set(s).add(id));
    if (maximized === id) setMaximized(null);
    // フォーカスは表示中の別のウィンドウへ
    if (p.focused === id) p.onFocus(shown.filter((w) => w.id !== id).at(-1)?.id ?? null);
  };

  const toggleMaximize = (id: number) => {
    setMaximized((m) => (m === id ? null : id));
    p.onFocus(id);
  };

  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  // 自由配置に切り替えたら、今のタイルの位置から始める
  const toggleLayout = () => {
    if (mode === 'tile') setFree(new Map(shown.map((w, i) => [w.id, tiles[i]!])));
    setMode((m) => (m === 'tile' ? 'free' : 'tile'));
  };

  const updateFree = (id: number, f: (r: Rect) => Rect) =>
    setFree((m) => new Map(m).set(id, f(m.get(id) ?? rectOf.get(id) ?? full)));

  const closeIds = (list: number[]) => list.length && p.onClose(list);

  const runPlay = (a: PlayAction) => {
    for (const t of targets()) {
      switch (a.do) {
        case 'toggle': t.toggle(); break;
        case 'seek': t.seekBy(a.sec); break;
        case 'step': t.step(a.dir); break;
        case 'percent': t.seekFraction(a.n / 10); break;
        case 'speed': t.speed(a.dir); break;
        case 'ab': t.ab(); break;
        case 'mute': t.toggleMute(); break;
        case 'zoom': t.toggleZoom(); break;
      }
    }
  };

  const runNormal = (a: NormalAction) => {
    switch (a.do) {
      case 'maximize': return p.focused !== null && toggleMaximize(p.focused);
      case 'all': {
        // 1つでも止まっていれば全部再生、全部再生中なら全部止める(比較用)
        const list = [...apis.current.values()].filter((x): x is PlayerApi => x !== null);
        const anyPaused = list.some((x) => x.isPaused());
        return list.forEach((x) => x.setPlaying(anyPaused));
      }
      case 'home': return p.onHome();
      case 'homeInitial': return p.onHomeInitial();
      case 'help': return setHelp((h) => !h);
      case 'history': return p.onHistory();
      case 'windowMode': return setWindowMode(true);
      case 'escape': return setHelp(false);
      default: return runPlay(a);
    }
  };

  const runWindow = (a: WindowAction) => {
    const f = p.focused;
    switch (a.do) {
      case 'focusN': {
        const w = ws[a.n - 1];
        return w && focus(w.id);
      }
      case 'focusDir': {
        const n = neighbor(shownRects, shownIndex, a.dir);
        return n !== null && p.onFocus(shown[n]!.id);
      }
      case 'moveDir': {
        if (f === null) return;
        if (mode === 'free') {
          const step = 40;
          const d = { h: [-step, 0], l: [step, 0], k: [0, -step], j: [0, step] }[a.dir];
          return updateFree(f, (r) => ({ ...r, x: r.x + d[0]!, y: r.y + d[1]! }));
        }
        // タイル配置では、その方向の隣と入れ替える
        const n = neighbor(shownRects, shownIndex, a.dir);
        if (n === null) return;
        return swap(f, shown[n]!.id);
      }
      case 'select': return f !== null && toggleSelect(f);
      case 'selectAll': return setSelected((s) => (s.size === ws.length ? new Set() : new Set(ws.map((w) => w.id))));
      case 'grow':
        if (mode !== 'free' || f === null) return;
        return updateFree(f, (r) => ({ ...r, w: r.w * a.f, h: r.h * a.f }));
      case 'equalize':
        setMaximized(null);
        setMinimized(new Set());
        return setMode('tile');
      case 'layout': return toggleLayout();
      case 'minimize': return f !== null && minimize(f);
      case 'maximize': return f !== null && toggleMaximize(f);
      case 'only': return closeIds(ws.filter((w) => w.id !== f).map((w) => w.id));
      case 'close': return closeIds(selected.size ? [...selected] : f !== null ? [f] : []);
      case 'closeAll':
        setWindowMode(false);
        return closeIds(ws.map((w) => w.id));
      case 'exit': return setWindowMode(false);
    }
  };

  /** 並び順で `a` と `b` を入れ替える(番号も変わる) */
  const swap = (a: number, b: number) => {
    const order = ws.map((w) => w.id);
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    [order[i], order[j]] = [order[j]!, order[i]!];
    p.onReorder(order);
  };

  // タイル配置のドラッグ: ポインタの下にあるウィンドウと入れ替える
  const startReorder = (id: number, e: React.PointerEvent) => {
    e.preventDefault();
    const box = area.current!.getBoundingClientRect();
    const targetAt = (x: number, y: number) => {
      const px = x - box.left;
      const py = y - box.top;
      const hit = shown.find((w) => {
        const r = rectOf.get(w.id)!;
        return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
      });
      return hit && hit.id !== id ? hit.id : null;
    };
    let target: number | null = null;
    setReorder({ id, target: null });
    const move = (ev: PointerEvent) => {
      target = targetAt(ev.clientX, ev.clientY);
      setReorder({ id, target });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setReorder(null);
      if (target !== null) swap(id, target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const windowMap = new KeySequence(windowKeys);
  useKeys((k, e) => {
    if (windowMode) {
      const a = windowMap.push(k.key);
      if (a === null || a === 'pending') return;
      e.preventDefault();
      return runWindow(a);
    }
    const a = normalMap.push(k.key);
    if (a === null) return;
    e.preventDefault();
    if (a !== 'pending') runNormal(a);
  }, p.active);

  // 閉じたウィンドウの操作を捨てる
  useEffect(() => {
    for (const id of apis.current.keys()) if (!ws.some((w) => w.id === id)) apis.current.delete(id);
  }, [ws]);

  return (
    <div className={`canvas${windowMode ? ' window-mode' : ''}`}>
      <header className="canvas-bar">
        <button type="button" className="icon-button" title={ja.toHome} aria-label={ja.toHome} onClick={p.onHome}>
          <Icon name="home" />
        </button>
        <div className="chips" role="tablist" aria-label={ja.taskbar} data-testid="taskbar">
          {ws.map((w, i) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === p.focused}
              className={`chip assist${w.id === p.focused ? ' selected' : ''}${minimized.has(w.id) ? ' minimized' : ''}`}
              onClick={() => {
                // Windows のタスクバーと同じ: 最小化中なら戻し、フォーカス中なら最小化する
                if (minimized.has(w.id)) focus(w.id);
                else if (w.id === p.focused) minimize(w.id);
                else focus(w.id);
              }}
            >
              <span className="chip-number">{i + 1}</span>
              {basename(w.path)}
            </button>
          ))}
        </div>
        {ws.length > 1 && (
          <button
            type="button"
            className="text-button with-icon"
            title={ja.wLayout}
            onClick={toggleLayout}
          >
            <Icon name={mode === 'tile' ? 'tile' : 'free'} size={18} />
            {mode === 'tile' ? ja.layoutTile : ja.layoutFree}
          </button>
        )}
      </header>
      <div ref={area} className="canvas-area" data-testid="canvas-area">
        {ws.length === 0 && <div className="canvas-empty">{ja.canvasEmpty}</div>}
        {ws.map((w, i) => (
          <PlayerWindow
            key={w.id}
            id={w.id}
            number={i + 1}
            path={w.path}
            media={w.media}
            rect={rectOf.get(w.id) ?? full}
            focused={w.id === p.focused}
            selected={selected.has(w.id)}
            maximized={maximized === w.id}
            minimized={minimized.has(w.id)}
            audible={p.visible && !minimized.has(w.id) && (shown.length === 1 || w.id === p.focused)}
            free={mode === 'free' && shown.length > 1 && maximized !== w.id}
            dropTarget={reorder?.target === w.id}
            api={(x) => {
              apis.current.set(w.id, x);
            }}
            onFocus={() => p.onFocus(w.id)}
            onClose={() => p.onClose([w.id])}
            onToggleSelect={() => toggleSelect(w.id)}
            onMinimize={() => minimize(w.id)}
            onToggleMaximize={() => toggleMaximize(w.id)}
            onReorderStart={(e) => startReorder(w.id, e)}
            onMove={(dx, dy) => updateFree(w.id, (r) => ({ ...r, x: r.x + dx, y: r.y + dy }))}
            onResize={(dw, dh) => updateFree(w.id, (r) => ({ ...r, w: Math.max(240, r.w + dw), h: Math.max(180, r.h + dh) }))}
          />
        ))}
      </div>
      {windowMode && (
        <div className="which-key" role="dialog" aria-label={ja.windowMode} data-testid="window-mode">
          <div className="which-key-title">
            {ja.windowMode}
            <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onClick={() => setWindowMode(false)}>
              <Icon name="close" size={18} />
            </button>
          </div>
          {windowHelp.map(([k, d]) => (
            <div key={k} className="which-key-row">
              <kbd>{k}</kbd>
              <span>{d}</span>
            </div>
          ))}
        </div>
      )}
      {help && (
        <div className="dialog-scrim" onClick={() => setHelp(false)}>
          <div className="dialog" role="dialog" aria-label={ja.keyHelp} onClick={(e) => e.stopPropagation()}>
            <h2>{ja.keyHelp}</h2>
            <dl>
              {ja.canvasKeys.map(([k, d]) => (
                <div key={k} className="help-row">
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
