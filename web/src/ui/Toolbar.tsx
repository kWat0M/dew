// Home とキャンバスの上部バーに並べる共通のボタン(履歴、キー一覧、操作パネル、停止)
import { ja } from '../i18n/ja';
import { Icon, type IconName } from '../icons';

export type ToolbarActions = {
  onHistory: () => void;
  onHelp: () => void;
  onPanel: () => void;
  onShutdown: () => void;
};

export function Toolbar(p: ToolbarActions) {
  const items: [IconName, string, () => void][] = [
    ['history', ja.history, p.onHistory],
    ['help', ja.keyHelp, p.onHelp],
    ['menu', ja.opsPanel, p.onPanel],
    ['power', ja.shutdown, p.onShutdown],
  ];
  return (
    <div className="toolbar">
      {items.map(([icon, label, run]) => (
        <button key={label} type="button" className="icon-button" title={label} aria-label={label} onClick={run}>
          <Icon name={icon} />
        </button>
      ))}
    </div>
  );
}
