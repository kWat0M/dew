// Home: yazi と同じ3カラム(親・現在・プレビュー)でファイルを選ぶ(4.1、5.2)
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { CommandDef } from '../commands';
import { HintBar } from '../ui/HintBar';
import { Toolbar, type ToolbarActions } from '../ui/Toolbar';
import { api, ApiError } from '../api/http';
import type { Events } from '../api/events';
import type { Entry } from '../protocol/Entry';
import type { MediaKind } from '../protocol/MediaKind';
import type { Tree } from '../protocol/Tree';
import { basename, join } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { KeySequence, leavesInput } from '../keys';
import { urlOf } from '../nav';
import { useKeys } from '../useKeys';
import { EntryList, type View } from './EntryList';
import { Preview } from './Preview';
import './Home.css';

export type HomeAction =
  | 'down' | 'up' | 'parent' | 'enter' | 'open' | 'mark' | 'top' | 'bottom'
  | 'filter' | 'follow' | 'view' | 'hidden' | 'canvas' | 'initial' | 'history' | 'help' | 'compare' | 'escape';

type Action = HomeAction;

/** 操作パネルに出す Home の操作(4.4) */
export const homeCommands: CommandDef<HomeAction>[] = [
  { id: 'down', key: 'j', label: '下へ' }, { id: 'up', key: 'k', label: '上へ' },
  { id: 'parent', key: 'h', label: '親へ' }, { id: 'enter', key: 'l', label: '中へ / 開く' },
  { id: 'open', key: 'Enter', label: '開く' }, { id: 'mark', key: 'Space', label: '選択' },
  { id: 'top', key: 'gg', label: '先頭' }, { id: 'bottom', key: 'G', label: '末尾' },
  { id: 'filter', key: '/', label: '絞り込み' }, { id: 'follow', key: 'n', label: '最新に追従' },
  { id: 'view', key: 'v', label: 'リスト / グリッド' }, { id: 'hidden', key: '.', label: '隠しファイル' },
  { id: 'initial', key: 'H', label: '初期位置へ' }, { id: 'canvas', key: 'Tab', label: 'キャンバスへ' },
  { id: 'compare', key: 'c', label: '選択を比較' },
];

/** 操作パネルの上に出す、画面にボタンがない操作 */
export const homeQuick: CommandDef<HomeAction>[] = [{ id: 'open', key: 'Enter', label: '選択をまとめて開く' }];

/** Home のキーマップ(キー一覧・ヒントとの突き合わせのテストにも使う) */
export const homeBindings: Record<string, HomeAction> = {
  j: 'down', ArrowDown: 'down', k: 'up', ArrowUp: 'up',
  h: 'parent', ArrowLeft: 'parent', l: 'enter', ArrowRight: 'enter',
  Enter: 'open', ' ': 'mark', 'g g': 'top', G: 'bottom',
  '/': 'filter', n: 'follow', v: 'view', '.': 'hidden', Tab: 'canvas', H: 'initial', r: 'history', '?': 'help', c: 'compare', Escape: 'escape', 'C-[': 'escape',
};
const keymap = new KeySequence<Action>(homeBindings);

export type DirRequest = { path: string; seq: number };

type Props = {
  events: Events;
  /** 閲覧範囲の起点(Markdown のプレビューで、範囲外の画像を出さない) */
  root: string;
  active: boolean;
  /** 表示を求めるディレクトリ(初期位置、H、dew <ディレクトリ> の指示) */
  dir: DirRequest | null;
  liveCount: number;
  onOpen: (files: { path: string; media: MediaKind }[]) => void;
  /** 選んだファイルを比較ウィンドウで開く(F7) */
  onCompare: (files: { path: string; media: MediaKind }[]) => void;
  onCanvas: () => void;
  /** ディレクトリを移った(ブラウザの履歴に積む。4.5) */
  onNavigate: (dir: string) => void;
  /** 初期位置へ戻る(H) */
  onInitial: () => void;
  onHistory: () => void;
  onHelp: () => void;
  /** 上部バーの右に並べる共通のボタンの操作 */
  toolbar: ToolbarActions;
  /** 初期位置(パンくずに印を付ける) */
  initialDir: string | null;
  hints: boolean;
  onHideHints: () => void;
  /** 隠しファイルの表示と、最新ファイルへの追従(操作パネルのチェックボックスと共有する) */
  showHidden: boolean;
  onShowHidden: (v: boolean) => void;
  follow: boolean;
  onFollow: (v: boolean) => void;
  /** 操作パネルから操作を実行するための入口 */
  runRef: Ref<(a: HomeAction) => void>;
  onError: (message: string) => void;
};

/** 開けるファイルか。開けないなら理由 */
function openable(e: Entry): string | null {
  if (!e.readable) return ja.unreadable;
  if (e.media === 'other') return ja.cannotOpenKind(e.name);
  return null;
}

export function Home(p: Props) {
  const [cwd, setCwd] = useState<string | null>(p.dir?.path ?? null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [parent, setParent] = useState<Tree | null>(null);
  const [reload, setReload] = useState(0);
  const [previewReload, setPreviewReload] = useState(0);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);

  /** Space・Ctrl+クリックなどで選んだファイル(フルパス → 項目)。別のディレクトリへ移っても残す */
  const [marked, setMarked] = useState<Map<string, Entry>>(new Map());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  /** ディレクトリごとに最後に選んでいた名前(戻ったとき・ブラウザの履歴で戻ったときに同じ位置にする) */
  const [remembered] = useState(() => new Map<string, string>());
  const followTarget = useRef<string | null>(null);
  const { onError, onOpen, onNavigate, showHidden, follow } = p;

  // 外から表示先が変わった(初期位置の取得、dew <ディレクトリ>)
  const [lastRequest, setLastRequest] = useState(p.dir);
  if (p.dir !== lastRequest) {
    setLastRequest(p.dir);
    if (p.dir) {
      setCwd(p.dir.path);
      setSelectedName(remembered.get(p.dir.path) ?? null);
      setFilter('');
    }
  }

  // 先に一覧を読めるか確かめ、読めたときだけ移る(閲覧範囲の外などは、メッセージだけ出して今の場所に留まる)
  const go = useCallback(
    (dir: string, select?: string) => {
      api.tree(dir).then(
        () => {
          if (select !== undefined) remembered.set(dir, select);
          setCwd(dir);
          setSelectedName(remembered.get(dir) ?? null);
          setFilter('');
          setChanged(new Set());
          if (dir !== cwd) onNavigate(dir);
        },
        (err: unknown) => onError(err instanceof ApiError ? err.message : String(err)),
      );
    },
    [cwd, onError, onNavigate, remembered],
  );

  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    api.tree(cwd).then(
      (t) => {
        if (!alive) return;
        setTree(t);
        // 追従モードで新しいファイルが来たら、選んで開く(F4)
        const target = followTarget.current;
        const e = target ? t.entries.find((x) => x.name === target) : undefined;
        if (e && e.kind === 'file' && openable(e) === null) {
          followTarget.current = null;
          setSelectedName(e.name);
          onOpen([{ path: join(t.path, e.name), media: e.media }]);
        }
      },
      (err: unknown) => alive && onError(err instanceof ApiError ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [cwd, reload, onError, onOpen]);

  const parentPath = tree?.path === cwd ? tree.parent : null;
  useEffect(() => {
    if (!parentPath) return;
    let alive = true;
    api.tree(parentPath).then((t) => alive && setParent(t), () => {});
    return () => {
      alive = false;
    };
  }, [parentPath, reload]);

  const entries = useMemo(() => {
    if (!tree || tree.path !== cwd) return [];
    const f = filter.toLowerCase();
    return tree.entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f)));
  }, [tree, cwd, showHidden, filter]);
  const parentEntries = useMemo(
    () => (parent && parent.path === parentPath ? parent.entries.filter((e) => showHidden || !e.name.startsWith('.')) : []),
    [parent, parentPath, showHidden],
  );

  const found = selectedName === null ? -1 : entries.findIndex((e) => e.name === selectedName);
  const selected = entries.length === 0 ? -1 : found >= 0 ? found : 0;
  const current = entries[selected];
  /** 右カラムに中身を出しているディレクトリ */
  const previewDir = cwd && current?.kind === 'dir' && current.readable ? join(cwd, current.name) : null;

  // 見ているディレクトリの変更を受け取る。右カラムに中身を出しているディレクトリも見る
  // (録画の開始でできた空の dew-recordings/ に、止めたときに MP4 ができても、プレビューが空のままだった)
  useEffect(() => {
    if (cwd) p.events.watch([cwd, parentPath, previewDir].filter((d): d is string => d !== null));
  }, [p.events, cwd, parentPath, previewDir]);
  useEffect(
    () =>
      p.events.subscribe((ev) => {
        // 監視の登録が済んだら読み直す(登録までの変更と、再接続までの変更を拾う)
        if (ev.type === 'watching') {
          if (cwd && ev.dirs.includes(cwd)) setReload((n) => n + 1);
          if (previewDir && ev.dirs.includes(previewDir)) setPreviewReload((n) => n + 1);
          return;
        }
        if (ev.type !== 'dirChanged') return;
        if (ev.dir === previewDir) setPreviewReload((n) => n + 1);
        if (ev.dir !== cwd && ev.dir !== parentPath) return;
        if (ev.dir === cwd) {
          setChanged((s) => new Set(s).add(ev.name));
          if (follow) followTarget.current = ev.name;
        }
        setReload((n) => n + 1);
      }),
    [p.events, cwd, parentPath, previewDir, follow],
  );

  const select = (i: number) => {
    const e = entries[Math.max(0, Math.min(entries.length - 1, i))];
    if (!e || !cwd) return;
    setSelectedName(e.name);
    remembered.set(cwd, e.name);
  };

  const pathOf = (e: Entry) => join(cwd ?? '', e.name);
  /** 今のディレクトリで選ばれている名前(一覧の表示用) */
  const markedHere = useMemo(() => new Set(entries.filter((e) => marked.has(join(cwd ?? '', e.name))).map((e) => e.name)), [entries, marked, cwd]);

  const toggleMark = (e: Entry) =>
    setMarked((m) => {
      const n = new Map(m);
      if (!n.delete(pathOf(e))) n.set(pathOf(e), e);
      return n;
    });

  /** クリック: Shift で今の位置からの範囲を、Ctrl で1つずつ複数選択に加える */
  const clickEntry = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && selected >= 0) {
      const [a, b] = selected < i ? [selected, i] : [i, selected];
      setMarked((m) => {
        const n = new Map(m);
        for (const x of entries.slice(a, b + 1)) n.set(pathOf(x), x);
        return n;
      });
    } else if (e.ctrlKey || e.metaKey) {
      const x = entries[i];
      if (x) toggleMark(x);
    }
    select(i);
  };

  const openEntries = (list: [string, Entry][]) => {
    const files: { path: string; media: MediaKind }[] = [];
    for (const [path, e] of list) {
      const reason = openable(e);
      if (reason) onError(reason);
      else files.push({ path, media: e.media });
    }
    if (files.length) onOpen(files);
  };

  const enter = (e: Entry | undefined) => {
    if (!e || !cwd) return;
    if (e.kind === 'dir') {
      if (!e.readable) onError(ja.unreadable);
      else go(join(cwd, e.name));
    } else {
      openEntries([[pathOf(e), e]]);
    }
  };

  const run = (a: Action) => {
    switch (a) {
      case 'down': return select(selected + 1);
      case 'up': return select(selected - 1);
      case 'top': return select(0);
      case 'bottom': return select(entries.length - 1);
      case 'parent':
        if (parentPath && cwd) go(parentPath, basename(cwd));
        return;
      case 'enter': return enter(current);
      case 'open': {
        // 選んだものがあれば(別のディレクトリのものも含めて)まとめて開く
        if (marked.size === 0) return enter(current);
        const list = [...marked].filter(([, e]) => e.kind === 'file');
        setMarked(new Map());
        return openEntries(list);
      }
      case 'mark':
        if (!current) return;
        toggleMark(current);
        return select(selected + 1);
      case 'filter': return setFiltering(true);
      case 'follow': return p.onFollow(!follow);
      case 'view': return setView((v) => (v === 'list' ? 'grid' : 'list'));
      case 'hidden': return p.onShowHidden(!showHidden);
      case 'canvas': return p.onCanvas();
      case 'initial': return p.onInitial();
      case 'history': return p.onHistory();
      case 'help': return p.onHelp();
      case 'compare': {
        const files = [...marked]
          .filter(([, e]) => e.kind === 'file' && (e.media === 'video' || e.media === 'image') && e.readable)
          .map(([path, e]) => ({ path, media: e.media }));
        if (files.length < 2) return onError(ja.compareNeedTwo);
        setMarked(new Map());
        return p.onCompare(files);
      }
      case 'escape':
        setMarked(new Map());
        setFilter('');
        return;
    }
  };

  useImperativeHandle(p.runRef, () => run);

  useKeys((k, e) => {
    const a = keymap.push(k.key);
    if (a === null) return;
    e.preventDefault();
    if (a !== 'pending') run(a);
  }, p.active && !filtering);

  const crumbs = useMemo(() => {
    if (!cwd) return [];
    const parts = cwd.split('/').filter(Boolean);
    return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))];
  }, [cwd]);

  return (
    <div className="home">
      <header className="home-bar">
        {/* キャンバスの Home ボタンと同じ位置に置く */}
        <button type="button" className="icon-button" title={ja.toCanvas} aria-label={ja.canvasButton} onClick={p.onCanvas}>
          <Icon name="canvas" />
        </button>
        <nav className="crumbs" aria-label="path">
          {crumbs.map((c, i) => {
            const initial = c.path === p.initialDir;
            return (
              <span key={c.path}>
                {i > 1 && <span className="crumb-sep">/</span>}
                {/* リンクにして、中クリックなどではブラウザの新しいタブでそのディレクトリを開けるようにする */}
                <a
                  href={urlOf({ screen: 'home', dir: c.path })}
                  className={`crumb${initial ? ' initial' : ''}`}
                  title={initial ? ja.initialDir : undefined}
                  data-testid={initial ? 'crumb-initial' : undefined}
                  onClick={(e) => {
                    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    go(c.path);
                  }}
                >
                  {c.name}
                </a>
              </span>
            );
          })}
          {current && (
            <span className="crumb-current">
              {crumbs.length > 1 && <span className="crumb-sep">/</span>}
              {current.name}
            </span>
          )}
        </nav>
        <div className="home-status">
          {marked.size > 0 && <span className="chip">{ja.selectedCount(marked.size)}</span>}
          {marked.size > 1 && (
            <button type="button" className="text-button with-icon" title={ja.compareKey} onClick={() => run('compare')}>
              <Icon name="compare" size={18} />
              {ja.compare}
            </button>
          )}
          {follow && <span className="chip">{ja.following}</span>}
          {showHidden && <span className="chip">{ja.hiddenShown}</span>}
          <Toolbar
            {...p.toolbar}
            lead={
              <button type="button" className="icon-button" title={ja.filter} aria-label={ja.filter} onClick={() => setFiltering(true)}>
                <Icon name="search" />
              </button>
            }
            middle={
              <button type="button" className="icon-button" title={view === 'list' ? ja.viewGrid : ja.viewList} aria-label={view === 'list' ? ja.viewGrid : ja.viewList} onClick={() => run('view')}>
                <Icon name={view === 'list' ? 'grid' : 'list'} />
              </button>
            }
          />
        </div>
      </header>
      {/* 抜けたあとも、絞り込んでいる間は欄を出しておく(Esc でもう一度押すと解除) */}
      {(filtering || filter !== '') && (
        <input
          className="filter"
          autoFocus={filtering}
          onFocus={() => setFiltering(true)}
          placeholder={`${ja.filter}(${ja.filterHint})`}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setSelectedName(null);
          }}
          onKeyDown={(e) => {
            // Enter・Esc・Ctrl+[ で欄から抜ける(絞り込みは残す)
            if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || leavesInput(e.nativeEvent)) {
              e.preventDefault();
              e.currentTarget.blur();
              setFiltering(false);
            }
          }}
        />
      )}
      <div className="columns">
        <EntryList
          testId="col-parent"
          label="parent"
          dir={parentPath ?? ''}
          entries={parentEntries}
          selected={cwd ? parentEntries.findIndex((e) => e.name === basename(cwd)) : -1}
          view="list"
          onClick={(i) => parentPath && go(join(parentPath, parentEntries[i]!.name))}
        />
        <EntryList
          testId="col-current"
          label="current"
          dir={cwd ?? ''}
          entries={entries}
          selected={selected}
          view={view}
          changed={changed}
          marked={markedHere}
          thumbs
          onClick={clickEntry}
          onDoubleClick={(i) => enter(entries[i])}
          empty={tree ? ja.emptyDir : ja.loading}
        />
        <Preview dir={cwd ?? ''} root={p.root} entry={current} showHidden={showHidden} reload={previewReload} />
      </div>
      {p.hints && <HintBar items={ja.homeHints} onHide={p.onHideHints} />}
      <button type="button" className="fab" title={ja.toCanvas} onClick={p.onCanvas}>
        <Icon name="canvas" size={24} />
        {p.liveCount > 0 && (
          <span className="fab-badge" aria-label={ja.liveWindows(p.liveCount)}>
            {p.liveCount}
          </span>
        )}
      </button>
    </div>
  );
}
