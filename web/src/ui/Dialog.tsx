// MD3 の Dialog。閉じるボタン付き。背景を押しても閉じる
import type { ReactNode } from 'react';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';

export function Dialog({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
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
