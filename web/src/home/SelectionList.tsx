// 選択中のファイルの一覧(m か「N 件を選択中」)。別のディレクトリで選んだものも、どれを選んだか確かめられるように
import { useEffect, useRef, useState } from 'react';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { KeySequence, readKey } from '../keys';
import './SelectionList.css';

type Action = 'down' | 'up' | 'top' | 'bottom' | 'go' | 'unmark' | 'close';

/** 一覧のキーマップ(ヒントの帯との突き合わせのテストにも使う) */
export const selectionBindings: Record<string, Action> = {
  j: 'down', ArrowDown: 'down', k: 'up', ArrowUp: 'up', 'g g': 'top', G: 'bottom',
  l: 'go', ArrowRight: 'go', Enter: 'go', ' ': 'unmark', q: 'close', Escape: 'close', 'C-[': 'close',
};
const keymap = new KeySequence<Action>(selectionBindings);

type Props = {
  /** 選んだもののフルパス */
  paths: string[];
  /** 閲覧範囲の起点(表示はここからの相対パスにする) */
  root: string;
  /** そのディレクトリへ移り、そのファイルにカーソルを置く */
  onGo: (path: string) => void;
  onUnmark: (path: string) => void;
  onClose: () => void;
};

function relative(root: string, path: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

export function SelectionList(p: Props) {
  // 別のディレクトリのものがまとまるよう、パスの順に並べる
  const paths = [...p.paths].sort((a, b) => a.localeCompare(b));
  const [cursor, setCursor] = useState(0);
  const cur = Math.max(0, Math.min(cursor, paths.length - 1));
  const listRef = useRef<HTMLUListElement>(null);

  const run = (a: Action) => {
    const path = paths[cur];
    switch (a) {
      case 'down': return setCursor(Math.min(paths.length - 1, cur + 1));
      case 'up': return setCursor(Math.max(0, cur - 1));
      case 'top': return setCursor(0);
      case 'bottom': return setCursor(paths.length - 1);
      case 'go': return path && p.onGo(path);
      case 'unmark': return path && p.onUnmark(path);
      case 'close': return p.onClose();
    }
  };
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  // 後ろの Home より先に受け取る。一覧の中のボタンを押したあとでも効くよう、ページ全体で受ける
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const k = readKey(e);
      if (!k) return;
      const a = keymap.push(k.key);
      if (a === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (a !== 'pending') runRef.current(a);
    };
    window.addEventListener('keydown', f, { capture: true });
    return () => window.removeEventListener('keydown', f, { capture: true });
  }, []);

  useEffect(() => {
    listRef.current?.children[cur]?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  // ボタンにフォーカスを移さない(Space・Enter をボタンではなく一覧のキーとして扱う)
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="selection-scrim" onClick={p.onClose}>
      <section className="selection-list" role="dialog" aria-label={ja.selectedList} data-testid="selection-list" onClick={(e) => e.stopPropagation()}>
        <header className="selection-bar">
          <h2>{ja.selectedList}</h2>
          <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onMouseDown={noFocus} onClick={p.onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <ul ref={listRef}>
          {paths.map((path, i) => (
            <li key={path} className={`selection-row${i === cur ? ' selected' : ''}`} data-current={i === cur} onMouseEnter={() => setCursor(i)}>
              <button type="button" className="selection-path" title={ja.showInDir(path)} onMouseDown={noFocus} onClick={() => p.onGo(path)}>
                {relative(p.root, path)}
              </button>
              <button type="button" className="text-button" onMouseDown={noFocus} onClick={() => p.onUnmark(path)}>
                {ja.unmark}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
