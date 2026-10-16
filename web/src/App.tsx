// 画面は Home とキャンバスの2つ(4章)。開いたファイルはキャンバスのウィンドウになる
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/http';
import { Events } from './api/events';
import { Canvas, type Win } from './canvas/Canvas';
import { Home } from './home/Home';
import { ja } from './i18n/ja';
import { readKey } from './keys';
import { Snackbar } from './ui/Snackbar';
import './App.css';

type Screen = 'home' | 'canvas';

/** 操作したことをサーバへ伝える間隔(dew <ファイル> の送り先を決めるのに使う) */
const ACTIVE_INTERVAL_MS = 1000;

export function App() {
  const [events] = useState(() => new Events());
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [windows, setWindows] = useState<Win[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const [ime, setIme] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const nextId = useRef(1);
  const lastActive = useRef(0);

  useEffect(() => {
    events.start();
    api.info().then(
      (info) => setHomeDir((d) => d ?? info.home),
      (e: unknown) => setMessage(String(e)),
    );
    return () => events.close();
  }, [events]);

  const open = useCallback((files: Omit<Win, 'id'>[]) => {
    const added = files.map((f) => ({ ...f, id: nextId.current++ }));
    setWindows((ws) => [...ws, ...added]);
    setFocused(added.at(-1)!.id);
    setScreen('canvas');
  }, []);

  // CLI からの表示指示(F10)
  useEffect(
    () =>
      events.subscribe((ev) => {
        if (ev.type !== 'open') return;
        if (ev.kind === 'dir') {
          setHomeDir(ev.path);
          setScreen('home');
        } else {
          open([{ path: ev.path, media: ev.media }]);
        }
      }),
    [events, open],
  );

  // 最初の操作で開始の表示を消す。以降は自動再生できる(7.6)。IME の状態も見る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = readKey(e);
      if (k) setIme(k.ime);
      else if (e.key === 'Process') setIme(true);
    };
    const onAny = (e: Event) => {
      if (!startedRef.current) {
        startedRef.current = true;
        setStarted(true);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      const now = Date.now();
      if (now - lastActive.current > ACTIVE_INTERVAL_MS) {
        lastActive.current = now;
        events.active();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onAny, { capture: true });
    window.addEventListener('pointerdown', onAny, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onAny, { capture: true });
      window.removeEventListener('pointerdown', onAny, { capture: true });
    };
  }, [events]);

  const onError = useCallback((m: string) => setMessage(m), []);
  const clearMessage = useCallback(() => setMessage(null), []);

  return (
    <div className="app">
      {screen === 'home' && (
        <Home
          events={events}
          active={started}
          dir={homeDir}
          liveCount={0}
          onOpen={open}
          onCanvas={() => setScreen('canvas')}
          onError={onError}
        />
      )}
      {screen === 'canvas' && (
        <Canvas
          active={started}
          windows={windows}
          focused={focused}
          onFocus={setFocused}
          onClose={(ids) => {
            const rest = windows.filter((w) => !ids.includes(w.id));
            setWindows(rest);
            if (focused !== null && ids.includes(focused)) setFocused(rest.at(-1)?.id ?? null);
          }}
          onReorder={(ids) => setWindows((ws) => ids.map((id) => ws.find((w) => w.id === id)!))}
          onHome={() => setScreen('home')}
        />
      )}
      {ime && <div className="ime">{ja.imeOn}</div>}
      {!started && (
        <div className="start-overlay" data-testid="start-overlay">
          <div className="start-card">
            <h1>{ja.appTitle}</h1>
            <p className="start-prompt">{ja.startPrompt}</p>
            <p className="start-hint">{ja.startHint}</p>
          </div>
        </div>
      )}
      <Snackbar message={message} onClose={clearMessage} />
    </div>
  );
}
