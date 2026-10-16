// 履歴ウィンドウ(4.4): 直近に開いたファイル。Home から親カラムを除いた2カラムで、操作も Home と同じ
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/http';
import type { History } from '../protocol/History';
import type { MediaKind } from '../protocol/MediaKind';
import { join } from '../format';
import { EntryList } from '../home/EntryList';
import { Preview } from '../home/Preview';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { KeySequence } from '../keys';
import { useKeys } from '../useKeys';
import './HistoryWindow.css';

type Action = 'down' | 'up' | 'top' | 'bottom' | 'mark' | 'open' | 'close';

const keymap = new KeySequence<Action>({
  j: 'down', ArrowDown: 'down', k: 'up', ArrowUp: 'up', 'g g': 'top', G: 'bottom',
  ' ': 'mark', Enter: 'open', l: 'open', q: 'close', Escape: 'close',
});

type Props = {
  onOpen: (files: { path: string; media: MediaKind }[]) => void;
  onClose: () => void;
  onError: (m: string) => void;
};

export function HistoryWindow(p: Props) {
  const [history, setHistory] = useState<History | null>(null);
  const [selected, setSelected] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const { onError } = p;

  useEffect(() => {
    let alive = true;
    api.history().then(
      (h) => alive && setHistory(h),
      (e: unknown) => alive && onError(e instanceof ApiError ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [onError]);

  const entries = history?.entries ?? [];
  const root = history?.root ?? '';
  const select = (i: number) => setSelected(Math.max(0, Math.min(entries.length - 1, i)));

  const open = (names: string[]) => {
    const files = entries.filter((e) => names.includes(e.name)).map((e) => ({ path: join(root, e.name), media: e.media }));
    if (files.length === 0) return;
    p.onClose();
    p.onOpen(files);
  };

  const run = (a: Action) => {
    const cur = entries[selected];
    switch (a) {
      case 'down': return select(selected + 1);
      case 'up': return select(selected - 1);
      case 'top': return select(0);
      case 'bottom': return select(entries.length - 1);
      case 'mark':
        if (!cur) return;
        setMarked((s) => {
          const n = new Set(s);
          if (!n.delete(cur.name)) n.add(cur.name);
          return n;
        });
        return select(selected + 1);
      case 'open': return open(marked.size ? [...marked] : cur ? [cur.name] : []);
      case 'close': return p.onClose();
    }
  };

  useKeys((k, e) => {
    const a = keymap.push(k.key);
    if (a === null) return;
    e.preventDefault();
    if (a !== 'pending') run(a);
  }, true);

  return (
    <div className="overlay-scrim" onClick={p.onClose}>
      <section className="history" role="dialog" aria-label={ja.history} data-testid="history" onClick={(e) => e.stopPropagation()}>
        <header className="overlay-bar">
          <Icon name="history" />
          <h2>{ja.history}</h2>
          {marked.size > 0 && <span className="chip">{ja.selectedCount(marked.size)}</span>}
          <span className="overlay-hint">{ja.historyHint}</span>
          <button type="button" className="icon-button" title={ja.close} aria-label={ja.close} onClick={p.onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="history-columns">
          <EntryList
            testId="history-list"
            label={ja.history}
            dir={root}
            entries={entries}
            selected={entries.length ? selected : -1}
            view="list"
            marked={marked}
            thumbs
            onClick={select}
            onDoubleClick={(i) => open([entries[i]!.name])}
            empty={history ? ja.historyEmpty : ja.loading}
          />
          <Preview dir={root} entry={entries[selected]} showHidden />
        </div>
      </section>
    </div>
  );
}
