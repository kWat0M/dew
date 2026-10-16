// 画面下のヒントの帯(4.4)。今のモードで効く主なキーを1行で出す
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import './HintBar.css';

export function HintBar({ items, onHide }: { items: readonly (readonly [string, string])[]; onHide: () => void }) {
  return (
    <div className="hint-bar" data-testid="hint-bar" role="note" aria-label={ja.hints}>
      {items.map(([k, label]) => (
        <span key={k} className="hint">
          <kbd>{k}</kbd>
          {label}
        </span>
      ))}
      <span className="spacer" />
      <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onClick={onHide}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
