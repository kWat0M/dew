// 画面は Home とキャンバスの2つ(4章)。開いたファイルはキャンバスのウィンドウになる
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/http';
import { Events } from './api/events';
import { Canvas, type Win } from './canvas/Canvas';
import { Home, type DirRequest } from './home/Home';
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
  /** Home の初期位置(最初に dew を起動したディレクトリ) */
  const [startDir, setStartDir] = useState<string | null>(null);
  /** Home に表示を求めるディレクトリ。seq を変えると同じ場所でも開き直す */
  const [homeRequest, setHomeRequest] = useState<DirRequest | null>(null);
  const seq = useRef(0);
  const [windows, setWindows] = useState<Win[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const [ime, setIme] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const nextId = useRef(1);
  const lastActive = useRef(0);

  useEffect(() => {
    events.start();
    api.info().then(
      (info) => {
        setStartDir(info.home);
        setHomeRequest((r) => r ?? { path: info.home, seq: seq.current++ });
      },
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
          setHomeRequest({ path: ev.path, seq: seq.current++ });
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
  const toInitial = useCallback(() => {
    if (startDir) setHomeRequest({ path: startDir, seq: seq.current++ });
  }, [startDir]);
  const clearMessage = useCallback(() => setMessage(null), []);

  return (
    <div className="app">
      {/* 両方の画面を作ったまま残し、見えていない方を隠す(Home の状態と再生を保つため。4.1) */}
      <div className="screen" hidden={screen !== 'home'}>
        <Home
          events={events}
          active={started && screen === 'home'}
          dir={homeRequest}
          liveCount={0}
          onOpen={open}
          onCanvas={() => setScreen('canvas')}
          onInitial={toInitial}
          onError={onError}
        />
      </div>
      <div className="screen" hidden={screen !== 'canvas'}>
        <Canvas
          active={started && screen === 'canvas'}
          visible={screen === 'canvas'}
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
          onHomeInitial={() => {
            toInitial();
            setScreen('home');
          }}
        />
      </div>
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
