// ドキュメントウィンドウ(15章): Markdown を読み取り専用で表示する。描画は別のチャンク(MarkdownView)で、
// このファイルはキー操作(17.4)・ファイルの更新(15.4)・文字コード(15.8)を受け持つ
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { api, ApiError } from '../api/http';
import type { Events } from '../api/events';
import { WindowFrame, type FrameProps } from '../canvas/WindowFrame';
import type { CommandDef } from '../commands';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { Icon, type IconName } from '../icons';
import { isLeaveKey, KeySequence, leavesInput } from '../keys';
import { nav, useNavState } from '../nav';
import type { MediaKind } from '../protocol/MediaKind';
import type { TextDoc } from '../protocol/TextDoc';
import type { TextEncoding } from '../protocol/TextEncoding';
import { useKeys } from '../useKeys';
import { useStable } from '../useStable';
import { classifyLink, dirname, type Link } from './links';
import './DocumentWindow.css';

const MarkdownView = lazy(() => import('./MarkdownView'));

/** 文字の大きさの5段階(17.3) */
const SCALES = [0.8, 0.9, 1, 1.15, 1.3];
/** j / k で動かす量 */
const LINE = 60;
/** h / l で動かす量 */
const COLUMN = 80;
/** リンクヒントに使う文字(ホームポジション。17.4) */
const HINT_CHARS = 'asdfghjkl';
/** 手で選べる文字コード(15.8) */
const CHOICES: TextEncoding[] = ['utf8', 'shiftJis', 'eucJp'];

export type DocAction =
  | { do: 'scroll'; lines: number }
  | { do: 'half'; dir: 1 | -1 }
  | { do: 'top' }
  | { do: 'bottom' }
  | { do: 'side'; dir: 1 | -1 }
  | { do: 'hints'; mode: HintMode }
  | { do: 'back' }
  | { do: 'forward' }
  | { do: 'search' }
  | { do: 'match'; dir: 1 | -1 }
  | { do: 'heading'; dir: 1 | -1 }
  | { do: 'toc' }
  | { do: 'up' }
  | { do: 'copyPath' }
  | { do: 'scale'; dir: 1 | -1 | 0 }
  | { do: 'encoding' }
  | { do: 'exit' };

/** 入力モードのキー(17.4) */
export const docKeys: Record<string, DocAction> = {
  j: { do: 'scroll', lines: 1 },
  k: { do: 'scroll', lines: -1 },
  ArrowDown: { do: 'scroll', lines: 1 },
  ArrowUp: { do: 'scroll', lines: -1 },
  d: { do: 'half', dir: 1 },
  u: { do: 'half', dir: -1 },
  'g g': { do: 'top' },
  G: { do: 'bottom' },
  h: { do: 'side', dir: -1 },
  l: { do: 'side', dir: 1 },
  ArrowLeft: { do: 'side', dir: -1 },
  ArrowRight: { do: 'side', dir: 1 },
  f: { do: 'hints', mode: 'open' },
  F: { do: 'hints', mode: 'window' },
  'y f': { do: 'hints', mode: 'copy' },
  H: { do: 'back' },
  L: { do: 'forward' },
  '/': { do: 'search' },
  n: { do: 'match', dir: 1 },
  N: { do: 'match', dir: -1 },
  ']': { do: 'heading', dir: 1 },
  '[': { do: 'heading', dir: -1 },
  o: { do: 'toc' },
  'g u': { do: 'up' },
  'y y': { do: 'copyPath' },
  '+': { do: 'scale', dir: 1 },
  '-': { do: 'scale', dir: -1 },
  '=': { do: 'scale', dir: 0 },
  e: { do: 'encoding' },
  q: { do: 'exit' },
  'C-[': { do: 'exit' },
};
const docMap = new KeySequence(docKeys);

/** 操作パネルの Markdown の節(4.4)。続けてキーで選ぶもの(f / F / yf、目次)は、押すと入力モードに入る */
const O = ja.docOps;
export const docCommands: CommandDef<DocAction>[] = [
  { id: docKeys.H!, key: 'H', label: O.back }, { id: docKeys.L!, key: 'L', label: O.forward },
  { id: docKeys.f!, key: 'f', label: O.hints }, { id: docKeys.F!, key: 'F', label: O.hintsWindow }, { id: docKeys['y f']!, key: 'yf', label: O.hintsCopy },
  { id: docKeys['/']!, key: '/', label: O.search }, { id: docKeys.n!, key: 'n', label: O.matchNext }, { id: docKeys.N!, key: 'N', label: O.matchPrev },
  { id: docKeys.o!, key: 'o', label: O.toc }, { id: docKeys[']']!, key: ']', label: O.nextHeading }, { id: docKeys['[']!, key: '[', label: O.prevHeading },
  { id: docKeys['g g']!, key: 'gg', label: O.top }, { id: docKeys.G!, key: 'G', label: O.bottom },
  { id: docKeys['+']!, key: '+', label: O.larger }, { id: docKeys['-']!, key: '-', label: O.smaller }, { id: docKeys['=']!, key: '=', label: O.resetScale },
  { id: docKeys.e!, key: 'e', label: O.encoding },
  { id: docKeys['g u']!, key: 'gu', label: O.up }, { id: docKeys['y y']!, key: 'yy', label: O.copyPath },
];

/** ヒントで選んだリンクをどうするか: 開く / dew の新しいウィンドウで開く / URL をコピー */
type HintMode = 'open' | 'window' | 'copy';
/** ヒントの対象: リンク(href あり)か、コードブロックのコピーボタン */
type Hint = {
  label: string;
  href?: string;
  el: HTMLElement;
  x: number;
  y: number;
};

/** ウィンドウ内で移った文書。image なら文書ではなく画像を出す(f で選んだ画像の気軽なプレビュー) */
type Visit = { path: string; image?: boolean };

/** n 個のヒントの文字。全部同じ長さにして、打ち終わりを分かりやすくする */
export function hintLabels(n: number): string[] {
  let len = 1;
  while (HINT_CHARS.length ** len < n) len++;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let j = 0, x = i; j < len; j++, x = Math.floor(x / HINT_CHARS.length)) s = HINT_CHARS[x % HINT_CHARS.length] + s;
    out.push(s);
  }
  return out;
}

/** 下部のバーのアイコンのボタン。説明にはキーも書く(マウスでもキーでも同じことができる) */
function BarButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  large,
  ref,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** 戻る・進む(バーの中央に大きめに出す) */
  large?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={ref} type="button" className={`icon-button doc-bar-button${large ? ' large' : ''}`} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={large ? 24 : 18} />
    </button>
  );
}

type Props = FrameProps & {
  id: number;
  /** 開いた文書(ウィンドウ内で移動すると onNavigate で知らせる) */
  path: string;
  /** 出す文書が、ウィンドウ内で何番目に移った先か。ブラウザの履歴(戻る・進む)が決める(4.5) */
  index: number;
  /** 閲覧範囲の起点 */
  root: string;
  events: Events;
  inputMode: boolean;
  externalImages: boolean;
  onToggleInput: () => void;
  onExitInput: () => void;
  onNavigate: (path: string) => void;
  /** リンクから別の文書へ移った(index 番目の文書として履歴に積んでもらう) */
  onVisit: (index: number) => void;
  /** リンクヒントを出しているか(画面下のヒントの帯を切り替える) */
  onHintsChange: (on: boolean) => void;
  /** 操作パネルから操作を実行する入口を渡す(閉じるときは null) */
  onRegister: (run: ((a: DocAction) => void) | null) => void;
  onOpenFiles: (files: { path: string; media: MediaKind }[]) => void;
  onOpenDir: (dir: string) => void;
  onMessage: (m: string) => void;
};

export function DocumentWindow({
  id,
  path: initial,
  index: wanted,
  root,
  events,
  inputMode,
  externalImages,
  onToggleInput,
  onExitInput,
  onNavigate,
  onVisit,
  onHintsChange,
  onRegister,
  onOpenFiles,
  onOpenDir,
  onMessage,
  ...frame
}: Props) {
  const section = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [visits, setVisits] = useState<Visit[]>([{ path: initial }]);
  const index = Math.min(wanted, visits.length - 1);
  const path = visits[index]!.path;
  const isImage = visits[index]!.image === true;
  /** 文書ごとのスクロール位置(ウィンドウ内の番号 → 位置。戻ったときに同じ位置にする) */
  const scrolls = useRef(new Map<number, number>());
  /** リンクで移った直後: 先頭から(# があればその見出しから)出す */
  const fresh = useRef<{ hash?: string } | null>(null);
  const navState = useNavState();
  const [loaded, setLoaded] = useState<{ path: string; doc: TextDoc } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [reload, setReload] = useState(0);
  const [encodings, setEncodings] = useState<Record<string, TextEncoding>>({});
  const [scale, setScale] = useState(2);
  const [hints, setHints] = useState<{
    mode: HintMode;
    typed: string;
    items: Hint[];
  } | null>(null);
  const [toc, setToc] = useState<{
    items: HTMLElement[];
    index: number;
  } | null>(null);
  const [search, setSearch] = useState<{
    query: string;
    editing: boolean;
    count: number;
    index: number;
  } | null>(null);
  const matches = useRef<Range[]>([]);
  const searchInput = useRef<HTMLInputElement>(null);
  /** 下部のバーの目次のボタン(押したときに、目次の外を押したとみなして閉じ、すぐ開き直さないように) */
  const tocButton = useRef<HTMLButtonElement>(null);
  /** 描画し直したあとに戻すスクロール位置と、開く見出し */
  const pending = useRef<{ scroll?: number; hash?: string } | null>(null);

  // 移動したら、キャンバスにも今の文書を知らせる(タブの名前と、同じ文書を開いたときの判定に使う)
  const onNavigateRef = useRef(onNavigate);
  const onHintsChangeRef = useRef(onHintsChange);
  useLayoutEffect(() => {
    onNavigateRef.current = onNavigate;
    onHintsChangeRef.current = onHintsChange;
  });
  useEffect(() => onNavigateRef.current(path), [path]);
  const hinting = hints !== null;
  useEffect(() => onHintsChangeRef.current(hinting), [hinting]);

  const encoding = encodings[path];
  useEffect(() => {
    if (isImage) return;
    let alive = true;
    api.text(path, encoding).then(
      (doc) => {
        if (!alive) return;
        setLoaded({ path, doc });
        setDeleted(false);
        setError(null);
      },
      (e: unknown) => {
        if (!alive) return;
        // 書き換えを見て読み直したら、なくなっていた: 最後の内容を残す(15.4)
        if (reload > 0 && e instanceof ApiError && (e.status === 404 || e.status === 403)) setDeleted(true);
        else setError(String(e instanceof Error ? e.message : e));
      },
    );
    return () => {
      alive = false;
    };
  }, [path, encoding, reload, isImage]);

  // ファイルの変更を監視する(F4 の仕組み)。変わったら、スクロール位置を保ったまま読み直す
  useEffect(() => {
    const owner = `doc-${id}`;
    const dir = dirname(path);
    const name = basename(path);
    events.watch([dir], owner);
    const off = events.subscribe((ev) => {
      if (ev.type === 'dirChanged' && ev.dir === dir && ev.name === name) setReload((n) => n + 1);
    });
    return () => {
      off();
      events.watch([], owner);
    };
  }, [events, id, path]);

  const body = () => scroller.current?.querySelector<HTMLElement>('[data-testid="doc-body"]') ?? null;

  /** 要素をスクロールの上端へ */
  const scrollToEl = (el: Element) => {
    const s = scroller.current;
    if (!s) return;
    s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top;
  };

  const scrollToId = (target: string) => {
    const b = body();
    if (!b) return;
    const el = b.querySelector(`[id="${CSS.escape(target)}"]`) ?? b.querySelector(`[id="${CSS.escape('user-content-' + target)}"]`);
    if (el) scrollToEl(el);
  };

  // 出す文書が変わったら、戻す位置を決める(読み込みを待つ間にスクロール位置が 0 に縮むので、ここで覚えておく)
  useLayoutEffect(() => {
    const f = fresh.current;
    fresh.current = null;
    pending.current = f ? { scroll: 0, hash: f.hash } : { scroll: scrolls.current.get(index) ?? 0 };
    matches.current = [];
  }, [index]);
  const [shownIndex, setShownIndex] = useState(index);
  if (shownIndex !== index) {
    setShownIndex(index);
    setSearch(null);
  }

  // 描画し直したら、覚えておいた位置へ
  const doc = loaded?.path === path ? loaded.doc : null;
  useLayoutEffect(() => {
    const p = pending.current;
    const el = scroller.current;
    if (!p || !el || !doc) return;
    pending.current = null;
    if (p.scroll !== undefined) el.scrollTop = p.scroll;
    if (p.hash) scrollToId(p.hash);
  });

  useEffect(() => {
    const el = section.current;
    el?.setAttribute('data-input', String(inputMode));
    el?.classList.toggle('input-mode', inputMode);
  }, [inputMode]);

  // 入力モードを抜けたら、開いているもの(ヒント・目次・検索欄)を閉じる
  const [wasInput, setWasInput] = useState(inputMode);
  if (wasInput !== inputMode) {
    setWasInput(inputMode);
    if (!inputMode) {
      setHints(null);
      setToc(null);
      if (search?.editing) setSearch(null);
    }
  }

  /**
   * ウィンドウ内で別の文書へ。ブラウザの履歴に積むので、戻る・進む(ボタン、H / L、ブラウザ、マウスのサイドボタン)で
   * 前の文書へ戻る(4.5)。今より先に移っていた文書は捨てる(ブラウザの履歴と同じ)
   */
  const navigate = (to: string, hash?: string, image?: boolean) => {
    for (const k of [...scrolls.current.keys()]) if (k > index) scrolls.current.delete(k);
    fresh.current = { hash };
    setVisits((v) => [...v.slice(0, index + 1), { path: to, image }]);
    onVisit(index + 1);
  };

  const copy = (text: string, done = ja.copied(text)) =>
    void navigator.clipboard?.writeText(text).then(
      () => onMessage(done),
      () => onMessage(ja.copyFailed),
    );
  const copyCode = useStable((text: string) => copy(text, ja.codeCopied));

  /** dew で開く: ディレクトリなら Home、画像はこのウィンドウの中(newWindow なら新しいウィンドウ)、そのほかはキャンバスの新しいウィンドウ */
  const openPath = async (target: string, newWindow: boolean) => {
    try {
      await api.tree(target);
      return onOpenDir(target);
    } catch {
      // ディレクトリではない
    }
    try {
      const entry = (await api.tree(dirname(target))).entries.find((e) => e.name === basename(target));
      if (!entry) return onMessage(`${basename(target)}: ${ja.notFound}`);
      if (entry.media === 'other') return onMessage(ja.cannotOpenKind(entry.name));
      if (entry.media === 'image' && !newWindow) return navigate(target, undefined, true);
      onOpenFiles([{ path: target, media: entry.media }]);
    } catch (e) {
      onMessage(String(e instanceof Error ? e.message : e));
    }
  };

  /** リンクを開く(17.2)。newWindow なら、dew で開けるものは新しいウィンドウで */
  const follow = useStable((link: Link, newWindow: boolean) => {
    switch (link.kind) {
      case 'anchor':
        return scrollToId(link.target);
      case 'external':
        return void window.open(link.target, '_blank', 'noopener,noreferrer');
      case 'markdown':
        if (newWindow) return onOpenFiles([{ path: link.target, media: 'markdown' }]);
        return navigate(link.target, link.hash);
      case 'path':
        return void openPath(link.target, newWindow);
      case 'none':
        return;
    }
  });

  /** 画面に見えているリンクにヒントを付ける */
  const showHints = (mode: HintMode) => {
    const s = scroller.current;
    const b = body();
    if (!s || !b) return;
    const box = s.getBoundingClientRect();
    const links = [...b.querySelectorAll<HTMLElement>('a[data-href], [data-hint="copy"]')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
    });
    if (!links.length) return;
    const labels = hintLabels(links.length);
    setHints({
      mode,
      typed: '',
      items: links.map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          label: labels[i]!,
          href: el.dataset.href,
          el,
          x: r.left - box.left + s.offsetLeft,
          y: r.top - box.top + s.offsetTop,
        };
      }),
    });
  };

  const pickHint = (h: Hint, mode: HintMode) => {
    setHints(null);
    // コードブロックのコピーボタンは、どのヒントで選んでもコピーする
    if (h.href === undefined) return h.el.click();
    const link = classifyLink(path, h.href);
    if (mode === 'copy') return copy(link.kind === 'markdown' || link.kind === 'path' ? link.target : h.href);
    follow(link, mode === 'window');
  };

  const headings = () => [...(body()?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? [])];
  /** 見出しの、スクロールの上端からの位置 */
  const offsetOf = (el: Element) => el.getBoundingClientRect().top - scroller.current!.getBoundingClientRect().top;

  /** ページ内検索(大文字小文字は区別しない)。一致を選択して見える位置へ */
  const runSearch = (query: string) => {
    const b = body();
    matches.current = [];
    if (b && query) {
      const q = query.toLowerCase();
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent!.toLowerCase();
        for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          matches.current.push(r);
        }
      }
    }
    setSearch({
      query,
      editing: false,
      count: matches.current.length,
      index: 0,
    });
    showMatch(0);
  };

  const showMatch = (i: number) => {
    const r = matches.current[i];
    const s = scroller.current;
    if (!r || !s) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight / 3;
  };

  const run = (a: DocAction) => {
    const s = scroller.current;
    if (!s) return;
    switch (a.do) {
      case 'scroll':
        return void (s.scrollTop += a.lines * LINE);
      case 'half':
        return void (s.scrollTop += (a.dir * s.clientHeight) / 2);
      case 'top':
        return void (s.scrollTop = 0);
      case 'bottom':
        return void (s.scrollTop = s.scrollHeight);
      case 'side':
        // 見えている幅の広い表・コードを横に動かす
        for (const el of s.querySelectorAll<HTMLElement>('.md-wide')) {
          const r = el.getBoundingClientRect();
          const box = s.getBoundingClientRect();
          if (r.bottom > box.top && r.top < box.bottom) el.scrollLeft += a.dir * COLUMN;
        }
        return void (s.scrollLeft += a.dir * COLUMN);
      case 'hints':
        return showHints(a.mode);
      case 'back':
        return nav.back();
      case 'forward':
        return nav.forward();
      case 'search':
        // 検索欄を出したまま抜けていたら、欄に戻る
        searchInput.current?.focus();
        return setSearch((x) => ({
          query: x?.query ?? '',
          editing: true,
          count: x?.count ?? 0,
          index: x?.index ?? 0,
        }));
      case 'match': {
        const n = matches.current.length;
        if (!search || !n) return;
        const index = (search.index + a.dir + n) % n;
        setSearch({ ...search, index });
        return showMatch(index);
      }
      case 'heading': {
        const hs = headings();
        const target = a.dir > 0 ? hs.find((h) => offsetOf(h) > 4) : hs.findLast((h) => offsetOf(h) < -4);
        return target && scrollToEl(target);
      }
      case 'toc': {
        const items = headings();
        // 今の位置の見出し(上端より上にある最後の見出し)から始める
        const current = items.findLastIndex((h) => offsetOf(h) <= 4);
        return setToc({ items, index: Math.max(0, current) });
      }
      case 'up':
        return onOpenDir(dirname(path));
      case 'copyPath':
        return copy(path);
      case 'scale':
        return setScale((x) => (a.dir === 0 ? 2 : Math.min(SCALES.length - 1, Math.max(0, x + a.dir))));
      case 'encoding': {
        // 手で選べる文字コードを順に切り替える(15.8)。UTF-16 などほかのものからは UTF-8 へ
        if (!doc) return;
        const next = CHOICES[(CHOICES.indexOf(doc.encoding) + 1) % CHOICES.length]!;
        setEncodings((m) => ({ ...m, [path]: next }));
        return onMessage(ja.encodingChanged(ja.encodings[next]));
      }
      case 'exit':
        setHints(null);
        setToc(null);
        setSearch(null);
        return onExitInput();
    }
  };

  // 操作パネルから。続けてキーで選ぶものは入力モードに入る
  const runFromPanel = useStable((a: DocAction) => {
    if ((a.do === 'hints' || a.do === 'toc') && !inputMode) onToggleInput();
    run(a);
  });
  const onRegisterRef = useRef(onRegister);
  useLayoutEffect(() => {
    onRegisterRef.current = onRegister;
  });
  useEffect(() => {
    onRegisterRef.current(runFromPanel);
    return () => onRegisterRef.current(null);
  }, [runFromPanel]);

  useKeys((k, e) => {
    if (hints) {
      // ヒントを出している間は、ほかのキーを受け付けない(17.4)。抜けるキーと Backspace で閉じる
      e.preventDefault();
      if (k.key === 'Backspace' || isLeaveKey(k.key)) return setHints(null);
      if (!HINT_CHARS.includes(k.key)) return;
      const typed = hints.typed + k.key;
      const left = hints.items.filter((h) => h.label.startsWith(typed));
      if (left.length === 1 && left[0]!.label === typed) return pickHint(left[0]!, hints.mode);
      if (left.length === 0) return;
      return setHints({ ...hints, typed });
    }
    if (toc) {
      e.preventDefault();
      if (k.key === 'o' || k.key === 'Backspace' || isLeaveKey(k.key)) return setToc(null);
      if (k.key === 'j' || k.key === 'ArrowDown')
        return setToc({
          ...toc,
          index: Math.min(toc.items.length - 1, toc.index + 1),
        });
      if (k.key === 'k' || k.key === 'ArrowUp') return setToc({ ...toc, index: Math.max(0, toc.index - 1) });
      if (k.key === 'Enter') {
        const h = toc.items[toc.index];
        setToc(null);
        if (h) scrollToEl(h);
      }
      return;
    }
    // 検索欄を出したまま抜けていたら、抜けるキーでまず検索欄を閉じる(1回で1段ずつ戻る)
    if (search?.editing && isLeaveKey(k.key)) {
      e.preventDefault();
      docMap.reset();
      return setSearch(null);
    }
    const a = docMap.push(k.key);
    if (a === null) return;
    e.preventDefault();
    if (a !== 'pending') run(a);
  }, inputMode);

  const name = basename(path);
  const large = doc?.large ?? false;
  return (
    <WindowFrame
      {...frame}
      testId="document-window"
      name={name}
      icon={isImage ? 'image' : 'article'}
      sectionRef={section}
      titleButtons={
        <button
          type="button"
          className={`icon-button small${inputMode ? ' input-on' : ''}`}
          title={inputMode ? ja.inputModeExit : ja.inputModeEnter}
          aria-label={inputMode ? ja.inputModeExit : ja.inputModeEnter}
          aria-pressed={inputMode}
          onClick={onToggleInput}
        >
          <Icon name="keyboard" size={18} />
        </button>
      }
    >
      <Popover.Root open={toc !== null} onOpenChange={(o) => !o && setToc(null)}>
        <Popover.Anchor asChild>
          <div
            ref={scroller}
            className={`doc-scroll${isImage ? ' image' : ''}`}
            data-testid="doc-scroll"
            style={{ ['--doc-scale' as string]: SCALES[scale] }}
            onScroll={(e) => scrolls.current.set(index, e.currentTarget.scrollTop)}
          >
            {isImage ? (
              <div className="doc-image">
                <img src={api.mediaUrl(path)} alt={name} data-testid="doc-image" />
              </div>
            ) : error && !doc ? (
              <div className="doc-message" role="alert">
                {error}
              </div>
            ) : !doc ? (
              <div className="doc-message">{ja.loading}</div>
            ) : large ? (
              <div className="md-body" data-testid="doc-body">
                <pre className="md-plain">{doc.text}</pre>
              </div>
            ) : (
              <Suspense fallback={<div className="doc-message">{ja.loading}</div>}>
                <MarkdownView text={doc.text} path={path} root={root} externalImages={externalImages} onLink={follow} onCopyCode={copyCode} />
              </Suspense>
            )}
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            className="doc-toc"
            data-testid="doc-toc"
            side="bottom"
            align="end"
            sideOffset={-40}
            alignOffset={8}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              if (tocButton.current?.contains(e.target as Node)) e.preventDefault();
            }}
            // 目次は Esc では閉じない(キー操作の側で o / Backspace で閉じる。15.3)
            onEscapeKeyDown={(e) => e.preventDefault()}
          >
            <div className="doc-toc-title">{ja.toc}</div>
            {toc && toc.items.length === 0 && <div className="doc-toc-empty">{ja.tocEmpty}</div>}
            <ul role="listbox" aria-label={ja.toc}>
              {toc?.items.map((h, i) => (
                <li
                  key={i}
                  role="option"
                  aria-selected={i === toc.index}
                  className={`doc-toc-item level-${h.tagName.slice(1)}`}
                  ref={(el) => {
                    if (i === toc.index) el?.scrollIntoView({ block: 'nearest' });
                  }}
                  onClick={() => {
                    setToc(null);
                    scrollToEl(h);
                  }}
                >
                  {h.textContent}
                </li>
              ))}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hints &&
        hints.items
          .filter((h) => h.label.startsWith(hints.typed))
          .map((h) => (
            <span key={h.label} className="link-hint" data-testid="link-hint" data-href={h.href} style={{ left: h.x, top: h.y }}>
              {h.label}
            </span>
          ))}
      {search?.editing && (
        <input
          ref={searchInput}
          className="doc-search"
          autoFocus
          defaultValue={search.query}
          placeholder={ja.searchPlaceholder}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            // Esc・Ctrl+[ は入力欄から抜けるだけ(検索欄は残し、もう一度押すと閉じる)
            if (e.key === 'Enter') runSearch(e.currentTarget.value);
            else if (leavesInput(e.nativeEvent)) e.currentTarget.blur();
            else return;
            e.preventDefault();
          }}
        />
      )}
      <footer className="doc-status" data-testid="doc-status">
        <div className="doc-status-side">
          {deleted && <span className="doc-note error">{ja.docDeleted}</span>}
          {large && <span className="doc-note">{ja.docLarge}</span>}
          {search && !search.editing && (
            <>
              <span className="doc-note">{ja.searchCount(search.index, search.count)}</span>
              {search.count > 1 && (
                <>
                  <BarButton icon="arrowUp" label={ja.matchPrev} onClick={() => run({ do: 'match', dir: -1 })} />
                  <BarButton icon="arrowDown" label={ja.matchNext} onClick={() => run({ do: 'match', dir: 1 })} />
                </>
              )}
            </>
          )}
        </div>
        {/* 戻る・進むはブラウザの戻る・進むと同じ(4.5)。押しやすいよう、バーの中央に大きめに置く */}
        <div className="doc-nav">
          <BarButton large icon="arrowBack" label={ja.docBack} disabled={!navState.back} onClick={() => nav.back()} />
          <BarButton large icon="arrowForward" label={ja.docForward} disabled={!navState.forward} onClick={() => nav.forward()} />
        </div>
        <div className="doc-status-side end">
          {!isImage && (
            <>
              <BarButton icon="search" label={ja.docSearch} pressed={search?.editing ?? false} onClick={() => (search?.editing ? setSearch(null) : run({ do: 'search' }))} />
              <BarButton ref={tocButton} icon="toc" label={ja.docToc} pressed={toc !== null} onClick={() => (toc ? setToc(null) : run({ do: 'toc' }))} />
              <span className="doc-divider" />
              <BarButton icon="textDecrease" label={ja.docSmaller} disabled={scale === 0} onClick={() => run({ do: 'scale', dir: -1 })} />
              <button type="button" className="text-button doc-scale" title={ja.docScaleReset} aria-label={ja.docScaleReset} onClick={() => run({ do: 'scale', dir: 0 })}>
                {Math.round(SCALES[scale]! * 100)}%
              </button>
              <BarButton icon="textIncrease" label={ja.docLarger} disabled={scale === SCALES.length - 1} onClick={() => run({ do: 'scale', dir: 1 })} />
              {doc && <span className="doc-divider" />}
            </>
          )}
          {doc && (
            <>
              <span className="doc-label">{ja.encoding}</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="text-button doc-encoding" data-testid="doc-encoding" title={ja.encodingKey}>
                  {ja.encodings[doc.encoding]}
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="doc-menu" align="end" sideOffset={4}>
                    <DropdownMenu.RadioGroup value={doc.encoding} onValueChange={(v) => setEncodings((m) => ({ ...m, [path]: v as TextEncoding }))}>
                      {CHOICES.map((c) => (
                        <DropdownMenu.RadioItem key={c} value={c} className="menu-item doc-menu-item">
                          {ja.encodings[c]}
                          {c === doc.detected && ` (${ja.detected})`}
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}
        </div>
      </footer>
    </WindowFrame>
  );
}
