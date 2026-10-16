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
import { KeySequence } from '../keys';
import { useKeys } from '../useKeys';
import { EntryList, type View } from './EntryList';
import { Preview } from './Preview';
import './Home.css';

export type HomeAction =
  | 'down' | 'up' | 'parent' | 'enter' | 'open' | 'mark' | 'top' | 'bottom'
  | 'filter' | 'follow' | 'view' | 'hidden' | 'canvas' | 'initial' | 'history' | 'help' | 'escape';

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
];

/** 操作パネルの上に出す、画面にボタンがない操作 */
export const homeQuick: CommandDef<HomeAction>[] = [{ id: 'open', key: 'Enter', label: '選択をまとめて開く' }];

const keymap = new KeySequence<Action>({
  j: 'down', ArrowDown: 'down', k: 'up', ArrowUp: 'up',
  h: 'parent', ArrowLeft: 'parent', l: 'enter', ArrowRight: 'enter',
  Enter: 'open', ' ': 'mark', 'g g': 'top', G: 'bottom',
  '/': 'filter', n: 'follow', v: 'view', '.': 'hidden', Tab: 'canvas', H: 'initial', r: 'history', '?': 'help', Escape: 'escape',
});

export type DirRequest = { path: string; seq: number };

type Props = {
  events: Events;
  active: boolean;
  /** 表示を求めるディレクトリ(初期位置、H、dew <ディレクトリ> の指示) */
  dir: DirRequest | null;
  liveCount: number;
  onOpen: (files: { path: string; media: MediaKind }[]) => void;
  onCanvas: () => void;
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
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);

  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  /** ディレクトリごとに最後に選んでいた名前(戻ったときに同じ位置にする) */
  const remembered = useRef(new Map<string, string>());
  const followTarget = useRef<string | null>(null);
  const { onError, onOpen, showHidden, follow } = p;

  // 外から表示先が変わった(初期位置の取得、dew <ディレクトリ>)
  const [lastRequest, setLastRequest] = useState(p.dir);
  if (p.dir !== lastRequest) {
    setLastRequest(p.dir);
    if (p.dir) {
      setCwd(p.dir.path);
      setSelectedName(null);
      setFilter('');
    }
  }

  // 先に一覧を読めるか確かめ、読めたときだけ移る(閲覧範囲の外などは、メッセージだけ出して今の場所に留まる)
  const go = useCallback(
    (dir: string, select?: string) => {
      api.tree(dir).then(
        () => {
          setCwd(dir);
          setSelectedName(select ?? remembered.current.get(dir) ?? null);
          setFilter('');
          setMarked(new Set());
          setChanged(new Set());
        },
        (err: unknown) => onError(err instanceof ApiError ? err.message : String(err)),
      );
    },
    [onError],
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

  // 見ているディレクトリの変更を受け取る
  useEffect(() => {
    if (cwd) p.events.watch(parentPath ? [cwd, parentPath] : [cwd]);
  }, [p.events, cwd, parentPath]);
  useEffect(
    () =>
      p.events.subscribe((ev) => {
        // 監視の登録が済んだら読み直す(登録までの変更と、再接続までの変更を拾う)
        if (ev.type === 'watching') {
          if (cwd && ev.dirs.includes(cwd)) setReload((n) => n + 1);
          return;
        }
        if (ev.type !== 'dirChanged' || (ev.dir !== cwd && ev.dir !== parentPath)) return;
        if (ev.dir === cwd) {
          setChanged((s) => new Set(s).add(ev.name));
          if (follow) followTarget.current = ev.name;
        }
        setReload((n) => n + 1);
      }),
    [p.events, cwd, parentPath, follow],
  );

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

  const select = (i: number) => {
    const e = entries[Math.max(0, Math.min(entries.length - 1, i))];
    if (!e || !cwd) return;
    setSelectedName(e.name);
    remembered.current.set(cwd, e.name);
  };

  /** クリック: Shift で今の位置からの範囲を、Ctrl で1つずつ複数選択に加える */
  const clickEntry = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && selected >= 0) {
      const [a, b] = selected < i ? [selected, i] : [i, selected];
      setMarked((s) => new Set([...s, ...entries.slice(a, b + 1).map((x) => x.name)]));
    } else if (e.ctrlKey || e.metaKey) {
      const name = entries[i]?.name;
      if (name)
        setMarked((s) => {
          const n = new Set(s);
          if (!n.delete(name)) n.add(name);
          return n;
        });
    }
    select(i);
  };

  const openEntries = (list: Entry[]) => {
    if (!cwd) return;
    const files: { path: string; media: MediaKind }[] = [];
    for (const e of list) {
      const reason = openable(e);
      if (reason) onError(reason);
      else files.push({ path: join(cwd, e.name), media: e.media });
    }
    if (files.length) onOpen(files);
  };

  const enter = (e: Entry | undefined) => {
    if (!e || !cwd) return;
    if (e.kind === 'dir') {
      if (!e.readable) onError(ja.unreadable);
      else go(join(cwd, e.name));
    } else {
      openEntries([e]);
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
        const list = marked.size ? entries.filter((e) => marked.has(e.name)) : current ? [current] : [];
        if (list.length === 1 && list[0]!.kind === 'dir') return enter(list[0]);
        setMarked(new Set());
        return openEntries(list.filter((e) => e.kind === 'file'));
      }
      case 'mark':
        if (!current) return;
        setMarked((s) => {
          const n = new Set(s);
          if (!n.delete(current.name)) n.add(current.name);
          return n;
        });
        return select(selected + 1);
      case 'filter': return setFiltering(true);
      case 'follow': return p.onFollow(!follow);
      case 'view': return setView((v) => (v === 'list' ? 'grid' : 'list'));
      case 'hidden': return p.onShowHidden(!showHidden);
      case 'canvas': return p.onCanvas();
      case 'initial': return p.onInitial();
      case 'history': return p.onHistory();
      case 'help': return p.onHelp();
      case 'escape':
        setMarked(new Set());
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
                <button
                  type="button"
                  className={`crumb${initial ? ' initial' : ''}`}
                  title={initial ? ja.initialDir : undefined}
                  data-testid={initial ? 'crumb-initial' : undefined}
                  onClick={() => go(c.path)}
                >
                  {initial && <Icon name="home" size={14} />}
                  {c.name}
                </button>
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
      {filtering && (
        <input
          className="filter"
          autoFocus
          placeholder={`${ja.filter}(${ja.filterHint})`}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setSelectedName(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              if (e.key === 'Escape') setFilter('');
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
          marked={marked}
          thumbs
          onClick={clickEntry}
          onDoubleClick={(i) => enter(entries[i])}
          empty={tree ? ja.emptyDir : ja.loading}
        />
        <Preview dir={cwd ?? ''} entry={current} showHidden={showHidden} />
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
