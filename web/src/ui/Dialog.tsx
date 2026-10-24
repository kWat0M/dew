// MD3 の Dialog。閉じるボタン付き。背景を押しても、Esc・Ctrl+[・q でも閉じる(文字を打つ欄では Esc・Ctrl+[ で欄から抜けるだけ)
import { useEffect, useRef, type ReactNode } from 'react';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { isLeaveKey, readKey } from '../keys';
import { isTyping } from '../useKeys';

export function Dialog({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // 後ろの画面のキー(Home の Esc など)より先に受け取る
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const k = readKey(e);
      if (!k || !isLeaveKey(k.key, isTyping(e.target))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isTyping(e.target)) (e.target as HTMLElement).blur();
      else close.current();
    };
    window.addEventListener('keydown', f, { capture: true });
    return () => window.removeEventListener('keydown', f, { capture: true });
  }, []);
  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          <h2>{title}</h2>
          <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}
