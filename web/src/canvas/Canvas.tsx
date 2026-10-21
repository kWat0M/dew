// キャンバス: 開いたファイルをフローティングウィンドウとして並べる(4.2、5.3、5.4)
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { CommandDef } from '../commands';
import { HintBar } from '../ui/HintBar';
import { Toolbar, type ToolbarActions } from '../ui/Toolbar';
import type { MediaKind } from '../protocol/MediaKind';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { KeySequence } from '../keys';
import { useKeys } from '../useKeys';
import { cascade, neighbor, tile, type Dir, type Rect } from './layout';
import { CompareWindow, type Member } from './CompareWindow';
import { LiveAudioMix, useLiveSound } from './liveAudio';
import { LiveWindow, type LiveApi, type LiveInfo } from './LiveWindow';
import { Dialog } from '../ui/Dialog';
import { PlayerWindow, type PlayerApi } from './PlayerWindow';
import { DocumentWindow } from '../doc/DocumentWindow';
import type { Events } from '../api/events';
import { SyncGroup } from './sync';
import './Canvas.css';

/** キャンバスのウィンドウ。members があれば比較ウィンドウ、media が markdown ならドキュメントウィンドウ */
export type Win = { id: number; path: string; media: MediaKind; members?: Member[]; live?: LiveInfo };

/** 再生のキー(選択中のウィンドウ、なければフォーカス中のウィンドウに効く) */
type PlayAction =
  | { do: 'toggle' } | { do: 'seek'; sec: number } | { do: 'step'; dir: 1 | -1 } | { do: 'percent'; n: number }
  | { do: 'speed'; dir: 1 | -1 } | { do: 'ab' } | { do: 'mute' } | { do: 'zoom' } | { do: 'zoomBy'; f: number };

/** 操作パネルから操作を実行するための入口 */
export type CanvasRun = {
  normal: (a: NormalAction) => void;
  window: (a: WindowAction) => void;
  /** Home へ戻るときに全ウィンドウを止める */
  pauseAll: () => void;
};

export type NormalAction =
  | PlayAction
  | { do: 'maximize' } | { do: 'all' } | { do: 'home' } | { do: 'homeInitial' } | { do: 'help' } | { do: 'history' }
  | { do: 'windowMode' } | { do: 'sync' } | { do: 'compareMode' } | { do: 'globalMute' } | { do: 'input' } | { do: 'sendText' }
  | { do: 'record' } | { do: 'live' } | { do: 'escape' };

/** ウィンドウ操作モードのキー */
export type WindowAction =
  | { do: 'focusN'; n: number } | { do: 'focusDir'; dir: Dir } | { do: 'moveDir'; dir: Dir }
  | { do: 'select' } | { do: 'selectAll' } | { do: 'grow'; f: number } | { do: 'equalize' } | { do: 'layout' }
  | { do: 'minimize' } | { do: 'maximize' } | { do: 'only' } | { do: 'close' } | { do: 'closeAll' } | { do: 'fitApp' } | { do: 'exit' };

/** キャンバスのキーマップ(キー一覧・ヒントとの突き合わせのテストにも使う) */
export const normal: Record<string, NormalAction> = {
  k: { do: 'toggle' }, ' ': { do: 'toggle' },
  j: { do: 'seek', sec: -5 }, l: { do: 'seek', sec: 5 }, ArrowLeft: { do: 'seek', sec: -5 }, ArrowRight: { do: 'seek', sec: 5 },
  J: { do: 'seek', sec: -30 }, L: { do: 'seek', sec: 30 },
  ',': { do: 'step', dir: -1 }, '.': { do: 'step', dir: 1 },
  '[': { do: 'speed', dir: -1 }, ']': { do: 'speed', dir: 1 },
  b: { do: 'ab' }, m: { do: 'mute' }, z: { do: 'zoom' }, '+': { do: 'zoomBy', f: 1.25 }, '-': { do: 'zoomBy', f: 0.8 }, f: { do: 'maximize' }, K: { do: 'all' },
  h: { do: 'home' }, H: { do: 'homeInitial' }, Tab: { do: 'home' }, '?': { do: 'help' },
  w: { do: 'windowMode' }, r: { do: 'history' }, s: { do: 'sync' }, c: { do: 'compareMode' }, M: { do: 'globalMute' }, i: { do: 'input' }, I: { do: 'sendText' }, R: { do: 'record' }, q: { do: 'live' }, Escape: { do: 'escape' },
};
for (let n = 0; n <= 9; n++) normal[String(n)] = { do: 'percent', n };

export const windowKeys: Record<string, WindowAction> = {
  h: { do: 'focusDir', dir: 'h' }, j: { do: 'focusDir', dir: 'j' }, k: { do: 'focusDir', dir: 'k' }, l: { do: 'focusDir', dir: 'l' },
  H: { do: 'moveDir', dir: 'h' }, J: { do: 'moveDir', dir: 'j' }, K: { do: 'moveDir', dir: 'k' }, L: { do: 'moveDir', dir: 'l' },
  ' ': { do: 'select' }, a: { do: 'selectAll' },
  '+': { do: 'grow', f: 1.1 }, '-': { do: 'grow', f: 1 / 1.1 }, '=': { do: 'equalize' }, t: { do: 'layout' },
  m: { do: 'minimize' }, f: { do: 'maximize' }, o: { do: 'only' }, x: { do: 'close' }, X: { do: 'closeAll' }, r: { do: 'fitApp' },
  q: { do: 'exit' }, Escape: { do: 'exit' },
};
for (let n = 1; n <= 9; n++) windowKeys[String(n)] = { do: 'focusN', n };

const normalMap = new KeySequence(normal);

/** ドキュメントウィンドウか(15.1) */
export function isDocument(w: Win): boolean {
  return !w.live && !w.members && w.media === 'markdown';
}

/** 操作パネルに出すキャンバスの操作(4.4) */
export const playCommands: CommandDef<NormalAction>[] = [
  { id: { do: 'toggle' }, key: 'k', label: '再生 / 一時停止' },
  { id: { do: 'seek', sec: -5 }, key: 'j', label: '5秒戻る' }, { id: { do: 'seek', sec: 5 }, key: 'l', label: '5秒進む' },
  { id: { do: 'seek', sec: -30 }, key: 'J', label: '30秒戻る' }, { id: { do: 'seek', sec: 30 }, key: 'L', label: '30秒進む' },
  { id: { do: 'step', dir: -1 }, key: ',', label: '1フレーム戻る' }, { id: { do: 'step', dir: 1 }, key: '.', label: '1フレーム進む' },
  { id: { do: 'percent', n: 0 }, key: '0', label: '先頭へ' }, { id: { do: 'percent', n: 5 }, key: '5', label: '中央へ' },
  { id: { do: 'speed', dir: -1 }, key: '[', label: '遅く' }, { id: { do: 'speed', dir: 1 }, key: ']', label: '速く' },
  { id: { do: 'ab' }, key: 'b', label: 'A-B ループ' }, { id: { do: 'mute' }, key: 'm', label: 'ミュート' },
  { id: { do: 'zoom' }, key: 'z', label: '等倍 / フィット' },
  { id: { do: 'zoomBy', f: 1.25 }, key: '+', label: '画像を拡大' }, { id: { do: 'zoomBy', f: 0.8 }, key: '-', label: '画像を縮小' }, { id: { do: 'all' }, key: 'K', label: '全ウィンドウ再生 / 停止' },
];
export const canvasCommands: CommandDef<NormalAction>[] = [
  { id: { do: 'home' }, key: 'h', label: 'Home へ戻る' }, { id: { do: 'homeInitial' }, key: 'H', label: 'Home の初期位置へ' },
  { id: { do: 'maximize' }, key: 'f', label: 'ウィンドウ最大化' }, { id: { do: 'windowMode' }, key: 'w', label: 'ウィンドウ操作モード' },
  { id: { do: 'globalMute' }, key: 'M', label: '全体のミュート' }, { id: { do: 'sync' }, key: 's', label: '同期再生' },
  { id: { do: 'input' }, key: 'i', label: '入力モード(ライブ)' }, { id: { do: 'sendText' }, key: 'I', label: '文字列を送る(ライブ)' }, { id: { do: 'record' }, key: 'R', label: '録画の開始 / 停止(ライブ)' }, { id: { do: 'live' }, key: 'q', label: 'ライブへ戻る(巻き戻し中)' }, { id: { do: 'compareMode' }, key: 'c', label: '比較の表示を切替' },
];
export const windowCommands: CommandDef<WindowAction>[] = [
  { id: { do: 'focusDir', dir: 'h' }, key: 'w h', label: '左のウィンドウへ' }, { id: { do: 'focusDir', dir: 'l' }, key: 'w l', label: '右のウィンドウへ' },
  { id: { do: 'focusDir', dir: 'k' }, key: 'w k', label: '上のウィンドウへ' }, { id: { do: 'focusDir', dir: 'j' }, key: 'w j', label: '下のウィンドウへ' },
  { id: { do: 'moveDir', dir: 'h' }, key: 'w H', label: '左へ移動' }, { id: { do: 'moveDir', dir: 'l' }, key: 'w L', label: '右へ移動' },
  { id: { do: 'moveDir', dir: 'k' }, key: 'w K', label: '上へ移動' }, { id: { do: 'moveDir', dir: 'j' }, key: 'w J', label: '下へ移動' },
  { id: { do: 'select' }, key: 'w Space', label: '選択を切替' }, { id: { do: 'selectAll' }, key: 'w a', label: '全選択 / 解除' },
  { id: { do: 'grow', f: 1.1 }, key: 'w +', label: '拡大' }, { id: { do: 'grow', f: 1 / 1.1 }, key: 'w -', label: '縮小' },
  { id: { do: 'equalize' }, key: 'w =', label: '均等に並べる' }, { id: { do: 'layout' }, key: 'w t', label: 'タイル / 自由配置' },
  { id: { do: 'minimize' }, key: 'w m', label: '最小化' }, { id: { do: 'maximize' }, key: 'w f', label: '最大化 / 元に戻す' },
  { id: { do: 'only' }, key: 'w o', label: 'ほかを閉じる' }, { id: { do: 'close' }, key: 'w x', label: 'ウィンドウを閉じる' },
  { id: { do: 'closeAll' }, key: 'w X', label: '全部閉じる' }, { id: { do: 'fitApp' }, key: 'w r', label: 'アプリの大きさを合わせる(ライブ)' },
];

/** 操作パネルの上に出す、画面にボタンがない操作 */
export const quickWindowCommands: CommandDef<WindowAction>[] = [
  { id: { do: 'grow', f: 1.1 }, key: 'w +', label: '拡大' }, { id: { do: 'grow', f: 1 / 1.1 }, key: 'w -', label: '縮小' },
  { id: { do: 'equalize' }, key: 'w =', label: '均等に並べる' }, { id: { do: 'selectAll' }, key: 'w a', label: '全選択 / 解除' },
  { id: { do: 'only' }, key: 'w o', label: 'ほかを閉じる' }, { id: { do: 'closeAll' }, key: 'w X', label: '全部閉じる' },
];
export const quickPlayCommands: CommandDef<NormalAction>[] = [
  { id: { do: 'ab' }, key: 'b', label: 'A-B ループ' }, { id: { do: 'all' }, key: 'K', label: '全ウィンドウ再生 / 停止' },
];

/** which-key 風の候補表示とキー一覧に出す行(キー、説明) */
export const windowHelp: [string, string][] = [
  ['1–9', ja.wFocusN], ['h/j/k/l', ja.wFocusDir], ['H/J/K/L', ja.wMoveDir], ['Space', ja.wSelect], ['a', ja.wSelectAll],
  ['+ / -', `${ja.wGrow} / ${ja.wShrink}`], ['=', ja.wEqualize], ['t', ja.wLayout], ['m', ja.minimize], ['f', ja.wMaximize],
  ['o', ja.wOnly], ['x', ja.wClose], ['X', ja.wCloseAll], ['r', ja.wFitApp], ['q', ja.windowModeExit],
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
  onHelp: () => void;
  onError: (m: string) => void;
  /** 上部バーの右に並べる共通のボタンの操作 */
  toolbar: ToolbarActions;
  /** Snackbar で伝えるメッセージ */
  onMessage: (m: string) => void;
  hints: boolean;
  onHideHints: () => void;
  tabbar: 'top' | 'side';
  /** 同期再生中は全ウィンドウの音を出す */
  syncAudio: boolean;
  /** 全体のミュート(各ウィンドウの音量・ミュートとは別に、全部の音を止める) */
  globalMuted: boolean;
  /** キャンバスに入った直後(約5秒)。音声のある動画があれば、ミュートボタンに「ミュートを解除」と出す */
  muteLabel: boolean;
  onToggleGlobalMute: () => void;
  /** 操作パネルから操作を実行するための入口 */
  runRef: Ref<CanvasRun>;
  /** ドキュメントウィンドウが使う: ファイルの監視、閲覧範囲の起点、外部の画像を読み込むか */
  events: Events;
  root: string;
  externalImages: boolean;
  /** このウィンドウを入力モードにする(ドキュメントを開いた直後。seq を変えると同じウィンドウでもやり直す) */
  inputRequest: { id: number; seq: number } | null;
  /** ドキュメントのリンクから開く */
  onOpenFiles: (files: { path: string; media: MediaKind }[]) => void;
  onOpenDir: (dir: string) => void;
  /** ドキュメントウィンドウの中で別の文書へ移った */
  onPathChange: (id: number, path: string) => void;
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
  /** 全ウィンドウの同期再生(s)。フォーカス中のウィンドウが基準 */
  const [synced, setSynced] = useState(false);
  /** 左端の縦のタブバーを出しているか */
  const [sideOpen, setSideOpen] = useState(false);
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
  /** 入力モード中のライブウィンドウ(L6)。その間はキャンバスのキーを止め、キーをアプリへ送る */
  const [inputWindow, setInputWindow] = useState<number | null>(null);
  /** I の送信用の入力欄 */
  const [textBox, setTextBox] = useState<string | null>(null);
  const focusedLive = ws.find((w) => w.id === p.focused && w.live && !w.live.ended);
  const focusedDoc = ws.find((w) => w.id === p.focused && isDocument(w));
  /** 入力モードにできるのは、動いているライブウィンドウとドキュメントウィンドウ */
  const inputTarget = focusedLive ?? focusedDoc;
  /** ノーマルモードの文書で再生のキーを押したときの案内は1回だけ(15.3) */
  const docHintShown = useRef(false);
  /** 巻き戻し中のライブウィンドウ(ヒントの帯の出し分けに使う) */
  const [rewinding, setRewinding] = useState<Set<number>>(new Set());
  const onRewind = useCallback(
    (id: number, on: boolean) =>
      setRewinding((s) => {
        if (s.has(id) === on) return s;
        const n = new Set(s);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      }),
    [],
  );
  /** ヒントの帯: フォーカス中のウィンドウの種類と状態で効くキー、続けてキャンバス共通のキー(4.4) */
  const canvasHints = (): [string, string][] => {
    const H = ja.canvasHints;
    const w = ws.find((x) => x.id === p.focused);
    let own: [string, string][] = [];
    if (w && isDocument(w)) {
      if (inputWindow === w.id) return H.docInput;
      own = H.doc;
    } else if (w?.live) {
      if (inputWindow === w.id) return H.input;
      own = w.live.exact ? H.exact : rewinding.has(w.id) ? H.rewind : H.live;
      if (w.live.recording) own = own.map(([k, l]) => [k, k === 'R' ? ja.hintRecordStop : l]);
    } else if (w?.members) own = [...H.video, ...H.compare];
    else if (w?.media === 'image') own = H.image;
    else if (w) own = H.video;
    return [...own, ...H.common];
  };
  // フォーカスが移ったり、ウィンドウが終わったりしたら入力モードを抜ける
  if (inputWindow !== null && inputTarget?.id !== inputWindow) setInputWindow(null);
  // ドキュメントを開いた直後は入力モードで始める(15.3)。フォーカスが移ったのを見てから入る
  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  if (p.inputRequest && p.inputRequest.seq !== handledRequest && p.focused === p.inputRequest.id) {
    setHandledRequest(p.inputRequest.seq);
    setInputWindow(p.inputRequest.id);
  }
  const exitInput = useCallback(() => setInputWindow(null), []);
  /** 音声のある動画のウィンドウ(全体のミュートボタンに「ミュートを解除」と出すかに使う) */
  const [withAudio, setWithAudio] = useState<Set<number>>(new Set());
  // ライブ描画の音。動いているライブウィンドウがある間だけ受け取る。どのウィンドウにも結びつかない音(セッション音声)は
  // 常に鳴らし、アプリの音はそのウィンドウで鳴らす(7.6、ADR 0013)
  const liveRunning = ws.some((w) => w.live && !w.live.ended);
  const [audioMix] = useState(() => new LiveAudioMix());
  useLiveSound(audioMix, liveRunning ? '/ws/live-audio' : null, p.visible && !p.globalMuted ? 1 : 0);
  const hasAudio = ws.some((w) => withAudio.has(w.id)) || liveRunning;
  // ウィンドウの読み込み処理をやり直させないよう、変わらない関数にしてウィンドウの ID と一緒に呼んでもらう
  const onHasAudio = useCallback(
    (id: number, has: boolean) =>
      setWithAudio((s) => {
        if (s.has(id) === has) return s;
        const n = new Set(s);
        if (has) n.add(id);
        else n.delete(id);
        return n;
      }),
    [],
  );
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

  const focusedApi = () => (p.focused === null ? null : (apis.current.get(p.focused) ?? null));

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

  const closeIds = (list: number[]) => {
    if (!list.length) return;
    // 動いているライブウィンドウは、アプリにも閉じるよう頼む(WM_DELETE_WINDOW。7.9)
    for (const w of ws) if (list.includes(w.id) && w.live && !w.live.ended) (apis.current.get(w.id) as LiveApi | null | undefined)?.closeApp?.();
    p.onClose(list);
  };

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
        case 'zoomBy': t.zoomBy?.(a.f); break;
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
      case 'help': return p.onHelp();
      case 'history': return p.onHistory();
      case 'windowMode': return setWindowMode(true);
      case 'sync': return setSynced((s) => !s);
      case 'globalMute': return p.onToggleGlobalMute();
      case 'input':
        if (!inputTarget) return p.onMessage(ja.inputNeedsLive);
        return setInputWindow(inputTarget.id);
      case 'sendText':
        if (!focusedLive) return p.onMessage(ja.inputNeedsLive);
        return setTextBox('');
      case 'record':
        if (!focusedLive) return p.onMessage(ja.recordNeedsLive);
        return (apis.current.get(focusedLive.id) as LiveApi | null | undefined)?.toggleRecord?.();
      case 'live': return targets().forEach((t) => (t as LiveApi).goLive?.());
      case 'compareMode': return focusedApi()?.cycleMode?.();
      case 'escape': return;
      default:
        // ドキュメントには再生のキーが効かない。i で操作できることを1回だけ知らせる(15.3)
        if (focusedDoc && !selected.size) {
          if (!docHintShown.current) p.onMessage(ja.docInputHint);
          docHintShown.current = true;
          return;
        }
        return runPlay(a);
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
      case 'grow': {
        if (f === null) return;
        const scale = (r: Rect) => ({ ...r, w: r.w * a.f, h: r.h * a.f });
        // タイル配置では大きさを変えられないので、自由配置でできる操作だと伝える
        if (mode !== 'free') return p.onMessage(ja.freeOnly);
        return updateFree(f, scale);
      }
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
      case 'fitApp': {
        if (!focusedLive) return p.onMessage(ja.fitNeedsLive);
        return (apis.current.get(focusedLive.id) as LiveApi | null | undefined)?.fitApp?.();
      }
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

  useImperativeHandle(p.runRef, () => ({
    normal: runNormal,
    window: runWindow,
    // ライブウィンドウは止めない(戻ったときにライブのまま見られるように。7.6 は動画の話)
    pauseAll: () => apis.current.forEach((a, id) => !ws.find((w) => w.id === id)?.live && a?.setPlaying(false)),
  }));

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
  }, p.active && inputWindow === null && textBox === null);

  // 同期再生: フォーカス中のウィンドウを基準に、ほかの動画を合わせる。ウィンドウや基準が変わったら組み直す
  useEffect(() => {
    if (!synced || p.focused === null) return;
    const master = apis.current.get(p.focused)?.video();
    if (!master) return;
    const followers = ws
      .filter((w) => w.id !== p.focused)
      .map((w) => apis.current.get(w.id)?.video())
      .filter((v): v is HTMLVideoElement => !!v);
    const group = new SyncGroup(master, followers);
    group.start();
    return () => group.stop();
  }, [synced, p.focused, ids, ws]);

  // 閉じたウィンドウの操作を捨てる
  useEffect(() => {
    for (const id of apis.current.keys()) if (!ws.some((w) => w.id === id)) apis.current.delete(id);
  }, [ws]);

  // タブバー(4.2)。上部に横並び、または左端に縦並びで普段は隠す
  const taskbar = (
        <div className={`chips ${p.tabbar}`} role="tablist" aria-label={ja.taskbar} data-testid="taskbar">
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
              {w.live ? w.live.title || ja.liveUntitled : w.members ? ja.compareTitle(w.members.map((m) => basename(m.path))) : basename(w.path)}
            </button>
          ))}
        </div>
  );

  return (
    <div className={`canvas${windowMode ? ' window-mode' : ''}`}>
      {p.tabbar === 'side' && (
        <>
          <div className="side-edge" onPointerEnter={() => setSideOpen(true)} />
          <nav className={`side-tabs${sideOpen ? ' open' : ''}`} onPointerLeave={() => setSideOpen(false)}>
            {taskbar}
          </nav>
        </>
      )}
      <header className="canvas-bar">
        <button type="button" className="icon-button" title={ja.toHome} aria-label={ja.toHome} onClick={p.onHome}>
          <Icon name="home" />
        </button>
        {p.tabbar === 'top' ? taskbar : <div className="chips" />}
        {synced && (
          <span className="chip sync-chip" data-testid="sync-indicator">
            {ja.syncing}
          </span>
        )}
        {/* 右側の並び: 全体のミュート → 同期 → 配置 → 履歴 → キー一覧 → 操作パネル → 停止 */}
        {/* 全体のミュート。キャンバスに入った直後は、音声のある動画があれば文字でも知らせる */}
        <button
          type="button"
          className={`global-mute${p.globalMuted ? ' muted' : ''}${p.globalMuted && p.muteLabel && hasAudio ? ' labeled' : ''}`}
          data-testid="global-mute"
          aria-pressed={p.globalMuted}
          aria-label={p.globalMuted ? ja.globalUnmute : ja.globalMute}
          title={`${p.globalMuted ? ja.globalUnmute : ja.globalMute}(M)`}
          onClick={p.onToggleGlobalMute}
        >
          <Icon name={p.globalMuted ? 'volumeOff' : 'volume'} />
          {p.globalMuted && p.muteLabel && hasAudio && <span>{ja.globalUnmute}</span>}
        </button>
        {ws.length > 1 && (
          <button
            type="button"
            className={`icon-button${synced ? ' toggled' : ''}`}
            title={ja.syncKey}
            aria-label={ja.sync}
            aria-pressed={synced}
            onClick={() => setSynced((s) => !s)}
          >
            <Icon name="sync" />
          </button>
        )}
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
        <Toolbar {...p.toolbar} />
      </header>
      <div ref={area} className={`canvas-area${mode === 'free' ? ' free' : ''}`} data-testid="canvas-area">
        {ws.length === 0 && <div className="canvas-empty">{ja.canvasEmpty}</div>}
        {ws.map((w, i) => {
          // 枠と配置は1ファイルのウィンドウと比較ウィンドウで共通
          const frame = {
            number: i + 1,
            rect: rectOf.get(w.id) ?? full,
            focused: w.id === p.focused,
            selected: selected.has(w.id),
            maximized: maximized === w.id,
            minimized: minimized.has(w.id),
            free: mode === 'free' && shown.length > 1 && maximized !== w.id,
            dropTarget: reorder?.target === w.id,
            onFocus: () => p.onFocus(w.id),
            onClose: () => closeIds([w.id]),
            onToggleSelect: () => toggleSelect(w.id),
            onMinimize: () => minimize(w.id),
            onToggleMaximize: () => toggleMaximize(w.id),
            onReorderStart: (e: React.PointerEvent) => startReorder(w.id, e),
            onMove: (dx: number, dy: number) => updateFree(w.id, (r) => ({ ...r, x: r.x + dx, y: r.y + dy })),
            onResize: (dw: number, dh: number) => updateFree(w.id, (r) => ({ ...r, w: Math.max(240, r.w + dw), h: Math.max(180, r.h + dh) })),
          };
          const audible =
            p.visible && !p.globalMuted && !minimized.has(w.id) && (shown.length === 1 || w.id === p.focused || (synced && p.syncAudio));
          const register = (x: PlayerApi | null) => {
            apis.current.set(w.id, x);
          };
          if (w.live)
            return (
              <LiveWindow
                key={w.id}
                {...frame}
                live={w.live}
                audioMix={audioMix}
                audible={audible}
                onMessage={p.onMessage}
                onRewind={(on) => onRewind(w.id, on)}
                inputMode={inputWindow === w.id}
                onToggleInput={() => {
                  // タイトルバーのボタンはフォーカスの操作を止めるので、ここでフォーカスする
                  p.onFocus(w.id);
                  setInputWindow((cur) => (cur === w.id ? null : w.id));
                }}
                onExitInput={exitInput}
                api={register}
              />
            );
          if (isDocument(w))
            return (
              <DocumentWindow
                key={w.id}
                {...frame}
                id={w.id}
                path={w.path}
                root={p.root}
                events={p.events}
                inputMode={inputWindow === w.id}
                externalImages={p.externalImages}
                onToggleInput={() => {
                  p.onFocus(w.id);
                  setInputWindow((cur) => (cur === w.id ? null : w.id));
                }}
                onExitInput={exitInput}
                onNavigate={(path) => p.onPathChange(w.id, path)}
                onOpenFiles={p.onOpenFiles}
                onOpenDir={p.onOpenDir}
                onMessage={p.onMessage}
              />
            );
          return w.members ? (
            <CompareWindow key={w.id} {...frame} id={w.id} members={w.members} audible={audible} onHasAudio={onHasAudio} api={register} onError={p.onError} />
          ) : (
            <PlayerWindow key={w.id} {...frame} id={w.id} path={w.path} media={w.media} audible={audible} onHasAudio={onHasAudio} api={register} />
          );
        })}
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
      {textBox !== null && (
        <Dialog title={ja.sendText} onClose={() => setTextBox(null)}>
          <input
            className="filter"
            autoFocus
            value={textBox}
            placeholder={ja.sendTextHint}
            onChange={(e) => setTextBox(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                const target = p.focused === null ? null : (apis.current.get(p.focused) as LiveApi | null | undefined);
                target?.sendText?.(textBox);
                setTextBox(null);
              }
            }}
          />
        </Dialog>
      )}
      {p.hints && <HintBar items={windowMode ? ja.windowHints : canvasHints()} onHide={p.onHideHints} />}
    </div>
  );
}
