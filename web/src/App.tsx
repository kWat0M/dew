// 画面は Home とキャンバスの2つ(4章)。開いたファイルはキャンバスのウィンドウになる
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/http';
import { Events } from './api/events';
import { canvasCommands, playCommands, quickPlayCommands, quickWindowCommands, windowCommands, windowHelp, Canvas, type CanvasRun, type NormalAction, type WindowAction, type Win } from './canvas/Canvas';
import type { Command, Section } from './commands';
import type { LiveWindow } from './protocol/LiveWindow';
import { useSettings } from './settings';
import { Dialog } from './ui/Dialog';
import { OpsPanel } from './ui/OpsPanel';
import type { ToolbarActions } from './ui/Toolbar';
import { HistoryWindow } from './history/HistoryWindow';
import { Home, homeCommands, homeQuick, type DirRequest, type HomeAction } from './home/Home';
import { ja } from './i18n/ja';
import { readKey } from './keys';
import { Snackbar } from './ui/Snackbar';
import { isTyping } from './useKeys';
import './App.css';

type Screen = 'home' | 'canvas';

/** キャンバスに入ってから「ミュートを解除」と文字で出しておく時間 */
const MUTE_LABEL_MS = 5000;

/** 操作したことをサーバへ伝える間隔(dew <ファイル> の送り先を決めるのに使う) */
const ACTIVE_INTERVAL_MS = 1000;

export function App() {
  const [events] = useState(() => new Events());
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [screen, setScreen] = useState<Screen>('home');
  const screenRef = useRef<Screen>('home');
  /** 全体のミュート。Home からキャンバスへ入るたびにオンにする(意図せず音が出ないように) */
  const [globalMuted, setGlobalMuted] = useState(true);
  /** キャンバスに入ってから約5秒は、ミュートボタンに「ミュートを解除」と出す */
  const [muteLabel, setMuteLabel] = useState(false);
  const muteLabelTimer = useRef<number | null>(null);
  const canvasRun = useRef<CanvasRun | null>(null);

  /** キャンバスへ。Home から入るときは全体のミュートをオンにする */
  const goCanvas = useCallback(() => {
    if (screenRef.current !== 'canvas') {
      setGlobalMuted(true);
      setMuteLabel(true);
      if (muteLabelTimer.current !== null) clearTimeout(muteLabelTimer.current);
      muteLabelTimer.current = window.setTimeout(() => setMuteLabel(false), MUTE_LABEL_MS);
    }
    screenRef.current = 'canvas';
    setScreen('canvas');
  }, []);

  /** Home へ。キャンバスの動画は止める */
  const goHome = useCallback(() => {
    if (screenRef.current === 'canvas') canvasRun.current?.pauseAll();
    screenRef.current = 'home';
    setScreen('home');
  }, []);
  /** Home の初期位置(最初に dew を起動したディレクトリ) */
  const [startDir, setStartDir] = useState<string | null>(null);
  /** Home に表示を求めるディレクトリ。seq を変えると同じ場所でも開き直す */
  const [homeRequest, setHomeRequest] = useState<DirRequest | null>(null);
  const seq = useRef(0);
  const [windows, setWindows] = useState<Win[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const [ime, setIme] = useState(false);
  /** 動いているライブウィンドウの数(Home の FAB のバッジ) */
  const [liveCount, setLiveCount] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [settings, updateSettings] = useSettings();
  // 隠しファイルの表示と最新ファイルへの追従。キーと操作パネルのチェックボックスで共有する
  const [showHidden, setShowHidden] = useState(false);
  const [follow, setFollow] = useState(false);
  const homeRun = useRef<((a: HomeAction) => void) | null>(null);
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
    api.addHistory(files.map((f) => f.path));
    setWindows((ws) => [...ws, ...added]);
    setFocused(added.at(-1)!.id);
    goCanvas();
  }, [goCanvas]);

  // 比較ウィンドウ(F7)。1つのウィンドウに複数のファイルを入れる
  const openCompare = useCallback((files: Omit<Win, 'id'>[]) => {
    const id = nextId.current++;
    api.addHistory(files.map((f) => f.path));
    setWindows((ws) => [...ws, { id, path: files[0]!.path, media: files[0]!.media, members: files }]);
    setFocused(id);
    goCanvas();
  }, [goCanvas]);

  // ライブ描画のウィンドウ(L1、L2)。サーバの一覧に合わせて、増えたら足し、消えたら「終了」にする
  const knownLive = useRef(new Set<number>());
  const onLiveWindows = useCallback(
    (list: LiveWindow[]) => {
      const present = new Map(list.map((l) => [l.id, l]));
      const added = list.filter((l) => !knownLive.current.has(l.id));
      for (const l of added) knownLive.current.add(l.id);
      const newWins = added.map((l) => ({
        id: nextId.current++,
        path: '',
        media: 'video' as const,
        live: { id: l.id, title: l.title, width: l.width, height: l.height, audio: l.audio, recording: l.recording, exact: l.exact, ended: false },
      }));
      setWindows((ws) => [
        ...ws.map((w) => {
          if (!w.live) return w;
          const l = present.get(w.live.id);
          return { ...w, live: l ? { ...w.live, title: l.title, width: l.width, height: l.height, audio: l.audio, recording: l.recording } : { ...w.live, ended: true, recording: false } };
        }),
        ...newWins,
      ]);
      setLiveCount(list.length);
      if (newWins.length) {
        setFocused(newWins.at(-1)!.id);
        goCanvas();
      }
    },
    [goCanvas],
  );

  // CLI からの表示指示(F10)
  useEffect(
    () =>
      events.subscribe((ev) => {
        if (ev.type === 'liveWindows') return onLiveWindows(ev.windows);
        if (ev.type !== 'open') return;
        if (ev.kind === 'dir') {
          setHomeRequest({ path: ev.path, seq: seq.current++ });
          goHome();
        } else {
          open([{ path: ev.path, media: ev.media }]);
        }
      }),
    [events, open, goHome, onLiveWindows],
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
    // マウスで押したボタンやチェックボックスにフォーカスを残さない(Space や Enter で押し直されないように)
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && !isTyping(t) && t.closest('button, input')) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onAny, { capture: true });
    window.addEventListener('pointerdown', onAny, { capture: true });
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onAny, { capture: true });
      window.removeEventListener('pointerdown', onAny, { capture: true });
    };
  }, [events]);

  const onError = useCallback((m: string) => setMessage(m), []);
  const stop = () => {
    setConfirmStop(false);
    void fetch('/api/shutdown', { method: 'POST' }).finally(() => {
      events.close();
      setStopped(true);
    });
  };

  const toolbar: ToolbarActions = {
    onHistory: () => setHistoryOpen(true),
    onHelp: () => setHelpOpen(true),
    onPanel: () => setPanelOpen((o) => !o),
    onShutdown: () => setConfirmStop(true),
  };
  const hideHints = () => updateSettings({ hints: false });

  const runHome = useCallback((a: HomeAction) => homeRun.current?.(a), []);
  const runNormal = useCallback((a: NormalAction) => canvasRun.current?.normal(a), []);
  const runWindow = useCallback((a: WindowAction) => canvasRun.current?.window(a), []);

  // 操作パネルに出す操作。今の画面のものと共通のもの(4.4)
  const sections: Section[] =
    screen === 'home'
      ? [{ title: ja.secHome, items: homeCommands.map((d) => ({ key: d.key, label: d.label, run: () => runHome(d.id) })) }]
      : [
          { title: ja.secPlay, items: playCommands.map((d) => ({ key: d.key, label: d.label, run: () => runNormal(d.id) })) },
          { title: ja.secCanvas, items: canvasCommands.map((d) => ({ key: d.key, label: d.label, run: () => runNormal(d.id) })) },
          { title: ja.secWindow, items: windowCommands.map((d) => ({ key: d.key, label: d.label, run: () => runWindow(d.id) })) },
        ];
  const quick: Command[] =
    screen === 'home'
      ? homeQuick.map((d) => ({ key: d.key, label: d.label, run: () => runHome(d.id) }))
      : [
          ...quickWindowCommands.map((d) => ({ key: d.key, label: d.label, run: () => runWindow(d.id) })),
          ...quickPlayCommands.map((d) => ({ key: d.key, label: d.label, run: () => runNormal(d.id) })),
        ];
  const toggles = [
    { label: ja.showHints, checked: settings.hints, onChange: (v: boolean) => updateSettings({ hints: v }) },
    ...(screen === 'home'
      ? [
          { label: ja.followLatest, checked: follow, onChange: setFollow },
          { label: ja.showHidden, checked: showHidden, onChange: setShowHidden },
        ]
      : [{ label: ja.syncAudio, checked: settings.syncAudio, onChange: (v: boolean) => updateSettings({ syncAudio: v }) }]),
  ];
  sections.push({
    title: ja.secCommon,
    items: [
      { key: 'r', label: ja.history, run: () => setHistoryOpen(true) },
      { key: '?', label: ja.keyHelp, run: () => setHelpOpen(true) },
      { key: '', label: ja.shutdown, run: () => setConfirmStop(true) },
    ],
  });

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
          active={started && screen === 'home' && !historyOpen}
          dir={homeRequest}
          liveCount={liveCount}
          onOpen={open}
          onCompare={openCompare}
          onCanvas={goCanvas}
          onInitial={toInitial}
          onHistory={() => setHistoryOpen(true)}
          onHelp={() => setHelpOpen(true)}
          toolbar={toolbar}
          initialDir={startDir}
          hints={settings.hints}
          onHideHints={hideHints}
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          follow={follow}
          onFollow={setFollow}
          runRef={homeRun}
          onError={onError}
        />
      </div>
      <div className="screen" hidden={screen !== 'canvas'}>
        <Canvas
          active={started && screen === 'canvas' && !historyOpen}
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
          onHome={goHome}
          onHistory={() => setHistoryOpen(true)}
          onHelp={() => setHelpOpen(true)}
          toolbar={toolbar}
          hints={settings.hints}
          onHideHints={hideHints}
          tabbar={settings.tabbar}
          onError={onError}
          syncAudio={settings.syncAudio}
          globalMuted={globalMuted}
          muteLabel={muteLabel}
          onToggleGlobalMute={() => setGlobalMuted((m) => !m)}
          onMessage={onError}
          runRef={canvasRun}
          onHomeInitial={() => {
            toInitial();
            goHome();
          }}
        />
      </div>
      {historyOpen && started && <HistoryWindow onOpen={open} onClose={() => setHistoryOpen(false)} onError={onError} />}
      {panelOpen && (
        <OpsPanel
          withHints={settings.hints}
          toggles={toggles}
          settings={settings}
          onSettings={updateSettings}
          quick={quick}
          sections={sections}
          onClose={() => setPanelOpen(false)}
        />
      )}
      {helpOpen && (
        <Dialog title={ja.keyHelp} onClose={() => setHelpOpen(false)}>
          {(
            [
              [ja.secHome, ja.homeKeys],
              [ja.secCanvas, ja.canvasKeys],
              [ja.windowMode, windowHelp],
            ] as const
          ).map(([title, rows]) => (
            <section key={title} className="help-section">
              <h3>{title}</h3>
              <dl>
                {rows.map(([k, d]) => (
                  <div key={k} className="help-row">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{d}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </Dialog>
      )}
      {confirmStop && (
        <Dialog
          title={ja.shutdown}
          onClose={() => setConfirmStop(false)}
          actions={
            <>
              <button type="button" className="text-button" onClick={() => setConfirmStop(false)}>
                {ja.cancel}
              </button>
              <button type="button" className="filled-button" onClick={stop}>
                {ja.shutdownDo}
              </button>
            </>
          }
        >
          <p>{ja.shutdownConfirm}</p>
        </Dialog>
      )}
      {stopped && (
        <div className="start-overlay stopped" data-testid="stopped">
          <div className="start-card">
            <h1>{ja.appTitle}</h1>
            <p className="start-prompt">{ja.stopped}</p>
          </div>
        </div>
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
