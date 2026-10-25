// 画面は Home とキャンバスの2つ(4章)。開いたファイルはキャンバスのウィンドウになる
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/http';
import { Events } from './api/events';
import { notificationAvailable, requestNotification, showNotification, UNSEEN_MARK } from './attention';
import { canvasCommands, isCsv, isDocument, playCommands, quickPlayCommands, quickWindowCommands, windowCommands, windowHelp, Canvas, type CanvasRun, type NormalAction, type WindowAction, type Win } from './canvas/Canvas';
import type { Command, Section } from './commands';
import type { LiveWindow } from './protocol/LiveWindow';
import { useSettings } from './settings';
import { Dialog } from './ui/Dialog';
import { CONFIRM_BYTES, prepare, start as startDownload, type DownloadItem } from './download';
import { formatSize } from './format';
import type { DownloadSize } from './protocol/DownloadSize';
import { OpsPanel } from './ui/OpsPanel';
import type { ToolbarActions } from './ui/Toolbar';
import { HistoryWindow } from './history/HistoryWindow';
import { docCommands } from './doc/DocumentWindow';
import { csvCommands } from './csv/keys';
import { Home, homeCommands, homeQuick, type DirRequest, type HomeAction } from './home/Home';
import { ja } from './i18n/ja';
import { nav, type Place } from './nav';
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
  /** 読み込んだときの場所(URL か、再読み込み前の履歴の項目。4.5) */
  const [initialPlace] = useState(() => nav.start());
  const [screen, setScreen] = useState<Screen>(initialPlace.screen);
  const screenRef = useRef<Screen>(initialPlace.screen);
  /** 全体のミュート。Home からキャンバスへ入るたびにオンにする(意図せず音が出ないように) */
  const [globalMuted, setGlobalMuted] = useState(true);
  /** キャンバスに入ってから約5秒は、ミュートボタンに「ミュートを解除」と出す */
  const [muteLabel, setMuteLabel] = useState(false);
  const muteLabelTimer = useRef<number | null>(null);
  const canvasRun = useRef<CanvasRun | null>(null);

  /** キャンバスを出す。Home から入るときは全体のミュートをオンにする */
  const showCanvas = useCallback(() => {
    if (screenRef.current !== 'canvas') {
      setGlobalMuted(true);
      setMuteLabel(true);
      if (muteLabelTimer.current !== null) clearTimeout(muteLabelTimer.current);
      muteLabelTimer.current = window.setTimeout(() => setMuteLabel(false), MUTE_LABEL_MS);
    }
    screenRef.current = 'canvas';
    setScreen('canvas');
  }, []);

  /** Home を出す。キャンバスの動画は止める */
  const showHome = useCallback(() => {
    if (screenRef.current === 'canvas') canvasRun.current?.pauseAll();
    screenRef.current = 'home';
    setScreen('home');
  }, []);
  /** Home の初期位置(最初に dew を起動したディレクトリ) */
  const [startDir, setStartDir] = useState<string | null>(null);
  /** 閲覧範囲の起点(Markdown の範囲外の画像を出さないのに使う) */
  const [root, setRoot] = useState('/');
  /** 開いた直後に操作モードにするウィンドウ(15.3、ADR 0030) */
  const [opRequest, setOpRequest] = useState<{ id: number; seq: number } | null>(null);
  const opSeq = useRef(0);
  /** Home に表示を求めるディレクトリ。seq を変えると同じ場所でも開き直す */
  const [homeRequest, setHomeRequest] = useState<DirRequest | null>(null);
  const seq = useRef(0);
  const [windows, setWindows] = useState<Win[]>([]);
  const windowsRef = useRef<Win[]>([]);
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);
  const [focused, setFocused] = useState<number | null>(null);
  const focusedRef = useRef<number | null>(null);
  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);
  /** Home で出しているディレクトリ(null は初期位置) */
  const homeDir = useRef<string | null>(initialPlace.screen === 'home' ? initialPlace.dir : null);
  const startDirRef = useRef<string | null>(null);

  /** キャンバスの今の場所(フォーカス中のウィンドウと、それが文書なら何番目の文書か) */
  const canvasPlace = useCallback((focus: number | null): Place => {
    const w = windowsRef.current.find((x) => x.id === focus);
    return { screen: 'canvas', focus, ...(w && isDocument(w) ? { doc: { win: w.id, index: w.doc ?? 0 } } : {}) };
  }, []);
  /** 履歴に新しい場所を積む。今の項目がキャンバスなら、離れる前のフォーカスを書いておく(戻ったときにそのウィンドウへ) */
  const pushPlace = useCallback(
    (place: Place) => {
      const cur = nav.current();
      if (cur?.screen === 'canvas') nav.replace({ ...cur, focus: focusedRef.current });
      nav.push(place);
    },
    [],
  );

  /** キャンバスへ移る(画面が変わるときだけ履歴に積む)。focus は入った先でフォーカスするウィンドウ */
  const goCanvas = useCallback(
    (focus: number | null = focusedRef.current) => {
      if (screenRef.current !== 'canvas') pushPlace(canvasPlace(focus));
      showCanvas();
    },
    [pushPlace, canvasPlace, showCanvas],
  );
  /** Home へ移る(履歴に積む) */
  const goHome = useCallback(() => {
    if (screenRef.current !== 'home') pushPlace({ screen: 'home', dir: homeDir.current });
    showHome();
  }, [pushPlace, showHome]);
  /** Home でそのディレクトリを開いて移る(null は初期位置。履歴に積む) */
  const homeAt = useCallback(
    (dir: string | null) => {
      const path = dir ?? startDirRef.current;
      if (path === null) return;
      homeDir.current = dir;
      setHomeRequest({ path, seq: seq.current++ });
      pushPlace({ screen: 'home', dir });
      showHome();
    },
    [pushPlace, showHome],
  );
  const [ime, setIme] = useState(false);
  /** 動いているライブウィンドウの数(Home の FAB のバッジ) */
  const [liveCount, setLiveCount] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [settings, updateSettings] = useSettings();
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const requestOp = useCallback((id: number) => {
    if (settingsRef.current.openInOpMode) setOpRequest({ id, seq: opSeq.current++ });
  }, []);
  // 隠しファイルの表示と最新ファイルへの追従。キーと操作パネルのチェックボックスで共有する
  const [showHidden, setShowHidden] = useState(false);
  const [follow, setFollow] = useState(false);
  const homeRun = useRef<((a: HomeAction) => void) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const nextId = useRef(1);
  const lastActive = useRef(0);
  /** /ws/events が切れている(サーバ停止中。つなぎ直しを試み続ける) */
  const [offline, setOffline] = useState(false);
  /** 裏にあるときに表示指示が届いた(タイトルに ● を付ける) */
  const [unseen, setUnseen] = useState(false);
  const baseTitle = useRef(document.title);

  useEffect(() => events.subscribeState((online) => setOffline(!online)), [events]);
  useEffect(() => {
    document.title = unseen ? UNSEEN_MARK + baseTitle.current : baseTitle.current;
  }, [unseen]);
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setUnseen(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    events.start();
    api.info().then(
      (info) => {
        setStartDir(info.home);
        startDirRef.current = info.home;
        setRoot(info.root);
        setHomeRequest((r) => r ?? { path: homeDir.current ?? info.home, seq: seq.current++ });
      },
      (e: unknown) => setMessage(String(e)),
    );
    return () => events.close();
  }, [events]);

  const open = useCallback(
    (files: Omit<Win, 'id'>[]) => {
      api.addHistory(files.map((f) => f.path));
      // 同じ文書がすでにあれば、新しく開かずにそのウィンドウへ(15.2)
      const existing = (f: Omit<Win, 'id'>) =>
        windowsRef.current.find((w) => (f.media === 'markdown' || f.media === 'csv') && (isDocument(w) || isCsv(w)) && w.path === f.path);
      const fresh = files.filter((f) => !existing(f));
      const added = fresh.map((f) => ({ ...f, id: nextId.current++ }));
      if (added.length) setWindows((ws) => [...ws, ...added]);
      const lastFile = files.at(-1)!;
      const target = existing(lastFile)?.id ?? added.at(-1)!.id;
      setFocused(target);
      requestOp(target);
      // 開いたばかりのウィンドウはまだ windowsRef にないので、文書なら最初の文書として積む
      if (screenRef.current !== 'canvas') pushPlace({ screen: 'canvas', focus: target, ...(lastFile.media === 'markdown' ? { doc: { win: target, index: 0 } } : {}) });
      showCanvas();
    },
    [pushPlace, showCanvas, requestOp],
  );

  // 比較ウィンドウ(F7)。1つのウィンドウに複数のファイルを入れる
  const openCompare = useCallback((files: Omit<Win, 'id'>[]) => {
    const id = nextId.current++;
    api.addHistory(files.map((f) => f.path));
    setWindows((ws) => [...ws, { id, path: files[0]!.path, media: files[0]!.media, members: files }]);
    setFocused(id);
    requestOp(id);
    goCanvas(id);
  }, [goCanvas, requestOp]);

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
        requestOp(newWins.at(-1)!.id);
        goCanvas(newWins.at(-1)!.id);
      }
    },
    [goCanvas, requestOp],
  );

  // CLI からの表示指示(F10)
  useEffect(
    () =>
      events.subscribe((ev) => {
        if (ev.type === 'liveWindows') return onLiveWindows(ev.windows);
        if (ev.type !== 'open') return;
        if (document.hidden) {
          setUnseen(true);
          if (settings.notify) showNotification(ja.notifyTitle, ev.path.split('/').pop() ?? ev.path);
        }
        if (ev.kind === 'dir') {
          homeAt(ev.path);
        } else {
          open([{ path: ev.path, media: ev.media }]);
        }
      }),
    [events, open, homeAt, onLiveWindows, settings.notify],
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
    // マウスで押したボタンやチェックボックスにフォーカスを残さない(Space や Enter で押し直されないように)。
    // 選択欄(data-keep-focus)は、開いた一覧を続けてキーで選べるように残す。キー(Enter)で押したとき(detail が 0)も残す
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (e.detail > 0 && t instanceof HTMLElement && !isTyping(t) && t.closest('button, input') && !t.closest('[data-keep-focus]')) {
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
  // 保存(18.3)。zip にまとめるときは先に合計を聞き、大きければ確かめる
  const [bigDownload, setBigDownload] = useState<{ items: DownloadItem[]; size: DownloadSize } | null>(null);
  const download = useCallback(
    async (items: DownloadItem[]) => {
      try {
        const size = await prepare(items);
        if (size && size.bytes > CONFIRM_BYTES) return setBigDownload({ items, size });
        startDownload(items);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [onError],
  );
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
  const toggleAutoHideBar = () => {
    updateSettings({ autoHideBar: !settings.autoHideBar });
    onError(settings.autoHideBar ? ja.barShown : ja.barHidden);
  };

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
  const canNotify = notificationAvailable();
  const toggles = [
    { label: ja.showHints, checked: settings.hints, onChange: (v: boolean) => updateSettings({ hints: v }) },
    { label: ja.openInOpMode, checked: settings.openInOpMode, onChange: (v: boolean) => updateSettings({ openInOpMode: v }) },
    { label: ja.externalImages, checked: settings.externalImages, onChange: (v: boolean) => updateSettings({ externalImages: v }) },
    {
      label: canNotify ? ja.notifyOpen : ja.notifyOpen + ja.notifyUnavailable,
      checked: canNotify && settings.notify,
      disabled: !canNotify,
      onChange: (v: boolean) => {
        if (!v) return updateSettings({ notify: false });
        void requestNotification().then((ok) => updateSettings({ notify: ok }));
      },
    },
    ...(screen === 'home'
      ? [
          { label: ja.followLatest, checked: follow, onChange: setFollow },
          { label: ja.showHidden, checked: showHidden, onChange: setShowHidden },
        ]
      : [
          { label: ja.autoHideBar, checked: settings.autoHideBar, onChange: (v: boolean) => updateSettings({ autoHideBar: v }) },
          { label: ja.syncAudio, checked: settings.syncAudio, onChange: (v: boolean) => updateSettings({ syncAudio: v }) },
        ]),
  ];
  sections.push({
    title: ja.secCommon,
    items: [
      { key: 'r', label: ja.history, run: () => setHistoryOpen(true) },
      { key: '?', label: ja.keyHelp, run: () => setHelpOpen(true) },
      { key: '', label: ja.shutdown, run: () => setConfirmStop(true) },
    ],
  });
  // フォーカス中の文書の操作は一番下に(基本は文書の下部のバーのボタンで操作する)
  const focusedWin = windows.find((w) => w.id === focused);
  if (screen === 'canvas' && focusedWin && isDocument(focusedWin))
    sections.push({ title: ja.secMarkdown, items: docCommands.map((d) => ({ key: d.key, label: d.label, run: () => canvasRun.current?.doc(d.id) })) });
  if (screen === 'canvas' && focusedWin && isCsv(focusedWin))
    sections.push({ title: ja.secCsv, items: csvCommands.map((d) => ({ key: d.key, label: d.label, run: () => canvasRun.current?.csv(d.id) })) });

  /** ドキュメントのリンクから、ディレクトリを Home で開く */
  const openDir = useCallback((dir: string) => homeAt(dir), [homeAt]);
  const onPathChange = useCallback((id: number, path: string) => setWindows((ws) => ws.map((w) => (w.id === id && w.path !== path ? { ...w, path } : w))), []);
  /** ドキュメントウィンドウの中でリンクから別の文書へ移った(履歴に積む) */
  const onVisit = useCallback(
    (id: number, index: number) => {
      setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, doc: index } : w)));
      pushPlace({ screen: 'canvas', focus: id, doc: { win: id, index } });
    },
    [pushPlace],
  );
  /** Home でディレクトリを移った(履歴に積む) */
  const onHomeNavigate = useCallback(
    (dir: string) => {
      homeDir.current = dir;
      pushPlace({ screen: 'home', dir });
    },
    [pushPlace],
  );

  // ブラウザの戻る・進む(マウスのサイドボタンも)で、その項目の場所を出し直す(4.5)
  useEffect(
    () =>
      nav.onPop((place) => {
        if (place.screen === 'home') {
          const path = place.dir ?? startDirRef.current;
          if (path !== null && place.dir !== homeDir.current) setHomeRequest({ path, seq: seq.current++ });
          homeDir.current = place.dir;
          return showHome();
        }
        const { focus, doc } = place;
        if (doc) setWindows((ws) => ws.map((w) => (w.id === doc.win ? { ...w, doc: doc.index } : w)));
        if (focus !== null && windowsRef.current.some((w) => w.id === focus)) setFocused(focus);
        showCanvas();
      }),
    [showHome, showCanvas],
  );

  const toInitial = useCallback(() => homeAt(null), [homeAt]);
  const clearMessage = useCallback(() => setMessage(null), []);

  return (
    <div className="app">
      {/* 両方の画面を作ったまま残し、見えていない方を隠す(Home の状態と再生を保つため。4.1) */}
      <div className="screen" hidden={screen !== 'home'}>
        <Home
          events={events}
          root={root}
          active={started && screen === 'home' && !historyOpen}
          dir={homeRequest}
          liveCount={liveCount}
          onOpen={open}
          onCompare={openCompare}
          onDownload={download}
          onCanvas={() => goCanvas()}
          onNavigate={onHomeNavigate}
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
          autoHideBar={settings.autoHideBar}
          onToggleAutoHideBar={toggleAutoHideBar}
          onError={onError}
          syncAudio={settings.syncAudio}
          globalMuted={globalMuted}
          muteLabel={muteLabel}
          onToggleGlobalMute={() => setGlobalMuted((m) => !m)}
          onMessage={onError}
          runRef={canvasRun}
          events={events}
          root={root}
          externalImages={settings.externalImages}
          opRequest={opRequest}
          onOpenFiles={open}
          onOpenDir={openDir}
          onPathChange={onPathChange}
          onVisit={onVisit}
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
              [ja.secOp, ja.opKeys],
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
      {bigDownload && (
        <Dialog
          title={ja.downloadBig}
          onClose={() => setBigDownload(null)}
          actions={
            <>
              <button type="button" className="text-button" onClick={() => setBigDownload(null)}>
                {ja.cancel}
              </button>
              <button
                type="button"
                className="filled-button"
                onClick={() => {
                  startDownload(bigDownload.items);
                  setBigDownload(null);
                }}
              >
                {ja.downloadDo}
              </button>
            </>
          }
        >
          <p>{ja.downloadBigConfirm(formatSize(bigDownload.size.bytes), bigDownload.size.files)}</p>
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
      {offline && !stopped && (
        <div className="server-offline" data-testid="server-offline" role="status">
          {ja.serverOffline}
        </div>
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
