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

type Action =
  | { do: 'toggle' } | { do: 'seek'; sec: number } | { do: 'step'; dir: 1 | -1 } | { do: 'percent'; n: number }
  | { do: 'speed'; dir: 1 | -1 } | { do: 'ab' } | { do: 'mute' } | { do: 'zoom' } | { do: 'maximize' }
  | { do: 'all' } | { do: 'home' } | { do: 'next' } | { do: 'help' } | { do: 'escape' }
  | { do: 'focusN'; n: number } | { do: 'focusDir'; dir: Dir } | { do: 'moveDir'; dir: Dir }
  | { do: 'grow'; f: number } | { do: 'equalize' } | { do: 'layout' } | { do: 'only' } | { do: 'close' };

const bindings: Record<string, Action> = {
  k: { do: 'toggle' }, ' ': { do: 'toggle' },
  j: { do: 'seek', sec: -5 }, l: { do: 'seek', sec: 5 }, ArrowLeft: { do: 'seek', sec: -5 }, ArrowRight: { do: 'seek', sec: 5 },
  J: { do: 'seek', sec: -30 }, L: { do: 'seek', sec: 30 },
  ',': { do: 'step', dir: -1 }, '.': { do: 'step', dir: 1 },
  '[': { do: 'speed', dir: -1 }, ']': { do: 'speed', dir: 1 },
  b: { do: 'ab' }, m: { do: 'mute' }, z: { do: 'zoom' }, f: { do: 'maximize' }, K: { do: 'all' },
  h: { do: 'home' }, Tab: { do: 'next' }, '?': { do: 'help' }, Escape: { do: 'escape' },
  'w h': { do: 'focusDir', dir: 'h' }, 'w j': { do: 'focusDir', dir: 'j' }, 'w k': { do: 'focusDir', dir: 'k' }, 'w l': { do: 'focusDir', dir: 'l' },
  'w H': { do: 'moveDir', dir: 'h' }, 'w J': { do: 'moveDir', dir: 'j' }, 'w K': { do: 'moveDir', dir: 'k' }, 'w L': { do: 'moveDir', dir: 'l' },
  'w +': { do: 'grow', f: 1.1 }, 'w -': { do: 'grow', f: 1 / 1.1 }, 'w =': { do: 'equalize' },
  'w t': { do: 'layout' }, 'w o': { do: 'only' }, 'w x': { do: 'close' },
};
for (let n = 0; n <= 9; n++) bindings[String(n)] = { do: 'percent', n };
for (let n = 1; n <= 9; n++) bindings[`w ${n}`] = { do: 'focusN', n };
const keymap = new KeySequence(bindings);

/** which-key に出す説明 */
function describe(a: Action): string {
  switch (a.do) {
    case 'focusN': return ja.wFocusN;
    case 'focusDir': return ja.wFocusDir;
    case 'moveDir': return ja.wMoveDir;
    case 'grow': return a.f > 1 ? ja.wGrow : ja.wShrink;
    case 'equalize': return ja.wEqualize;
    case 'layout': return ja.wLayout;
    case 'only': return ja.wOnly;
    case 'close': return ja.wClose;
    default: return '';
  }
}

type Props = {
  active: boolean;
  windows: Win[];
  focused: number | null;
  onFocus: (id: number) => void;
  onClose: (ids: number[]) => void;
  onReorder: (ids: number[]) => void;
  onHome: () => void;
};

export function Canvas(p: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  const [mode, setMode] = useState<'tile' | 'free'>('tile');
  const [free, setFree] = useState(new Map<number, Rect>());
  const [maximized, setMaximized] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [help, setHelp] = useState(false);
  const apis = useRef(new Map<number, PlayerApi | null>());

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ws = p.windows;
  const index = ws.findIndex((w) => w.id === p.focused);
  const tiles = tile(ws.length, size.w, size.h);
  const full: Rect = { x: 0, y: 0, w: size.w, h: size.h };
  const rects = ws.map((w, i): Rect => {
    if (ws.length === 1 || maximized === w.id) return full;
    if (mode === 'free') return free.get(w.id) ?? cascade(i, size.w, size.h);
    return tiles[i]!;
  });
  const focusedApi = () => (p.focused === null ? null : apis.current.get(p.focused) ?? null);

  // 自由配置に切り替えたら、今のタイルの位置から始める
  const toggleLayout = () => {
    if (mode === 'tile') setFree(new Map(ws.map((w, i) => [w.id, tiles[i]!])));
    setMode((m) => (m === 'tile' ? 'free' : 'tile'));
  };

  const updateFree = (id: number, f: (r: Rect) => Rect) => {
    setFree((m) => {
      const i = ws.findIndex((w) => w.id === id);
      const next = new Map(m);
      next.set(id, f(m.get(id) ?? rects[i] ?? full));
      return next;
    });
  };

  const run = (a: Action, shift: boolean) => {
    const api = focusedApi();
    switch (a.do) {
      case 'toggle': return api?.toggle();
      case 'seek': return api?.seekBy(a.sec);
      case 'step': return api?.step(a.dir);
      case 'percent': return api?.seekFraction(a.n / 10);
      case 'speed': return api?.speed(a.dir);
      case 'ab': return api?.ab();
      case 'mute': return api?.toggleMute();
      case 'zoom': return api?.toggleZoom();
      case 'maximize': return setMaximized((m) => (m === p.focused ? null : p.focused));
      case 'all': {
        // 1つでも止まっていれば全部再生、全部再生中なら全部止める(比較用)
        const list = [...apis.current.values()].filter((x): x is PlayerApi => x !== null);
        const anyPaused = list.some((x) => x.isPaused());
        return list.forEach((x) => x.setPlaying(anyPaused));
      }
      case 'home': return p.onHome();
      case 'next': {
        if (ws.length === 0) return;
        const n = (index + (shift ? -1 : 1) + ws.length) % ws.length;
        return p.onFocus(ws[n]!.id);
      }
      case 'help': return setHelp((h) => !h);
      case 'escape':
        setHelp(false);
        return setMaximized(null);
      case 'focusN': {
        const w = ws[a.n - 1];
        return w && p.onFocus(w.id);
      }
      case 'focusDir': {
        const n = neighbor(rects, index, a.dir);
        return n !== null && p.onFocus(ws[n]!.id);
      }
      case 'moveDir': {
        if (mode === 'free' && p.focused !== null) {
          const step = 40;
          const d = { h: [-step, 0], l: [step, 0], k: [0, -step], j: [0, step] }[a.dir];
          return updateFree(p.focused, (r) => ({ ...r, x: r.x + d[0]!, y: r.y + d[1]! }));
        }
        // タイル配置では、その方向の隣と入れ替える
        const n = neighbor(rects, index, a.dir);
        if (n === null) return;
        const ids = ws.map((w) => w.id);
        [ids[index], ids[n]] = [ids[n]!, ids[index]!];
        return p.onReorder(ids);
      }
      case 'grow':
        if (mode !== 'free' || p.focused === null) return;
        return updateFree(p.focused, (r) => ({ ...r, w: r.w * a.f, h: r.h * a.f }));
      case 'equalize':
        setMaximized(null);
        return setMode('tile');
      case 'layout': return toggleLayout();
      case 'only': return p.onClose(ws.filter((w) => w.id !== p.focused).map((w) => w.id));
      case 'close': return p.focused !== null && p.onClose([p.focused]);
    }
  };

  useKeys((k, e) => {
    const a = keymap.push(k.key);
    setPending(a === 'pending');
    if (a === null) return;
    e.preventDefault();
    if (a !== 'pending') run(a, e.shiftKey);
  }, p.active);

  // 閉じたウィンドウの操作を捨てる
  useEffect(() => {
    for (const id of apis.current.keys()) if (!ws.some((w) => w.id === id)) apis.current.delete(id);
  }, [ws]);

  return (
    <div className="canvas">
      <header className="canvas-bar">
        <button type="button" className="icon-button" title={ja.toHome} onClick={p.onHome}>
          <Icon name="home" />
        </button>
        <div className="chips">
          {ws.map((w, i) => (
            <button
              key={w.id}
              type="button"
              className={`chip assist${w.id === p.focused ? ' selected' : ''}`}
              onClick={() => p.onFocus(w.id)}
            >
              <span className="chip-number">{i + 1}</span>
              {basename(w.path)}
            </button>
          ))}
        </div>
        <span className="canvas-mode">{ws.length > 1 && (mode === 'tile' ? ja.layoutTile : ja.layoutFree)}</span>
      </header>
      <div ref={area} className="canvas-area">
        {ws.length === 0 && <div className="canvas-empty">{ja.canvasEmpty}</div>}
        {ws.map((w, i) => (
          <PlayerWindow
            key={w.id}
            id={w.id}
            number={i + 1}
            path={w.path}
            media={w.media}
            rect={rects[i]!}
            focused={w.id === p.focused}
            audible={ws.length === 1 || w.id === p.focused}
            free={mode === 'free' && ws.length > 1 && maximized !== w.id}
            api={(x) => {
              apis.current.set(w.id, x);
            }}
            onFocus={() => p.onFocus(w.id)}
            onClose={() => p.onClose([w.id])}
            onMove={(dx, dy) => updateFree(w.id, (r) => ({ ...r, x: r.x + dx, y: r.y + dy }))}
            onResize={(dw, dh) => updateFree(w.id, (r) => ({ ...r, w: Math.max(240, r.w + dw), h: Math.max(180, r.h + dh) }))}
          />
        ))}
      </div>
      {pending && (
        <div className="which-key" role="dialog" aria-label={ja.windowCommand}>
          <div className="which-key-title">{ja.windowCommand}</div>
          {['1–9', 'h/j/k/l', 'H/J/K/L', '+', '-', '=', 't', 'o', 'x'].map((k) => (
            <div key={k} className="which-key-row">
              <kbd>{k}</kbd>
              <span>{describe(bindings[`w ${k[0]}`]!)}</span>
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
