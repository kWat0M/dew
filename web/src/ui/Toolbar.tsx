// Home とキャンバスの上部バー右側の共通のボタン。並びは [lead][履歴][middle][キー一覧][操作パネル][停止]
import type { ReactNode } from 'react';
import { ja } from '../i18n/ja';
import { Icon, type IconName } from '../icons';
import { useCompact } from '../useCompact';

export type ToolbarActions = {
  onHistory: () => void;
  onHelp: () => void;
  onPanel: () => void;
  onShutdown: () => void;
};

function Button({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-button" title={label} aria-label={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

export function Toolbar(p: ToolbarActions & { lead?: ReactNode; middle?: ReactNode }) {
  // 幅の狭い画面ではキーボードがない前提なので、キー一覧は出さない(18.2)
  const compact = useCompact();
  return (
    <div className="toolbar">
      {p.lead}
      <Button icon="history" label={ja.history} onClick={p.onHistory} />
      {p.middle}
      {!compact && <Button icon="help" label={ja.keyHelp} onClick={p.onHelp} />}
      <Button icon="menu" label={ja.opsPanel} onClick={p.onPanel} />
      <Button icon="power" label={ja.shutdown} onClick={p.onShutdown} />
    </div>
  );
}
