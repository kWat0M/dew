// Home: yazi と同じ3カラム(親・現在・プレビュー)でファイルを選ぶ(4.1、5.2)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api/http';
import type { Events } from '../api/events';
import type { Entry } from '../protocol/Entry';
import type { Tree } from '../protocol/Tree';
import { basename, join } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { KeySequence } from '../keys';
import { useKeys } from '../useKeys';
import { EntryList, type View } from './EntryList';
import { Preview } from './Preview';
import './Home.css';

type Action =
  | 'down' | 'up' | 'parent' | 'enter' | 'open' | 'mark' | 'top' | 'bottom'
  | 'filter' | 'follow' | 'view' | 'hidden' | 'canvas' | 'escape';

const keymap = new KeySequence<Action>({
  j: 'down', ArrowDown: 'down', k: 'up', ArrowUp: 'up',
  h: 'parent', ArrowLeft: 'parent', l: 'enter', ArrowRight: 'enter',
  Enter: 'open', ' ': 'mark', 'g g': 'top', G: 'bottom',
  '/': 'filter', n: 'follow', v: 'view', '.': 'hidden', Tab: 'canvas', Escape: 'escape',
});

type Props = {
  events: Events;
  active: boolean;
  /** 表示するディレクトリ(初期位置、または dew <ディレクトリ> の指示) */
  dir: string | null;
  liveCount: number;
  onOpen: (paths: string[]) => void;
  onCanvas: () => void;
  onError: (message: string) => void;
};

/** 開けるファイルか。開けないなら理由 */
function openable(e: Entry): string | null {
  if (!e.readable) return ja.unreadable;
  if (e.media === 'other') return ja.cannotOpenKind(e.name);
  return null;
}

export function Home(p: Props) {
  const [cwd, setCwd] = useState<string | null>(p.dir);
  const [tree, setTree] = useState<Tree | null>(null);
  const [parent, setParent] = useState<Tree | null>(null);
  const [reload, setReload] = useState(0);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [follow, setFollow] = useState(false);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  /** ディレクトリごとに最後に選んでいた名前(戻ったときに同じ位置にする) */
  const remembered = useRef(new Map<string, string>());
  const followTarget = useRef<string | null>(null);
  const { onError, onOpen } = p;

  // 外から表示先が変わった(初期位置の取得、dew <ディレクトリ>)
  const [lastDir, setLastDir] = useState(p.dir);
  if (p.dir !== lastDir) {
    setLastDir(p.dir);
    setCwd(p.dir);
  }

  const go = useCallback((dir: string, select?: string) => {
    setCwd(dir);
    setSelectedName(select ?? remembered.current.get(dir) ?? null);
    setFilter('');
    setMarked(new Set());
    setChanged(new Set());
  }, []);

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
          onOpen([join(t.path, e.name)]);
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

  const openEntries = (list: Entry[]) => {
    if (!cwd) return;
    const files: string[] = [];
    for (const e of list) {
      const reason = openable(e);
      if (reason) onError(reason);
      else files.push(join(cwd, e.name));
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
      case 'follow': return setFollow((f) => !f);
      case 'view': return setView((v) => (v === 'list' ? 'grid' : 'list'));
      case 'hidden': return setShowHidden((h) => !h);
      case 'canvas': return p.onCanvas();
      case 'escape':
        setMarked(new Set());
        setFilter('');
        return;
    }
  };

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
        <nav className="crumbs" aria-label="path">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 1 && <span className="crumb-sep">/</span>}
              <button type="button" className="crumb" onClick={() => go(c.path)}>
                {c.name}
              </button>
            </span>
          ))}
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
          <button type="button" className="icon-button" title={view === 'list' ? ja.viewGrid : ja.viewList} onClick={() => run('view')}>
            <Icon name={view === 'list' ? 'grid' : 'list'} />
          </button>
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
          onClick={select}
          onDoubleClick={(i) => enter(entries[i])}
          empty={tree ? ja.emptyDir : ja.loading}
        />
        <Preview dir={cwd ?? ''} entry={current} showHidden={showHidden} />
      </div>
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
