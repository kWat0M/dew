// 操作パネル(4.4): 上から、設定 → 画面にボタンがない操作 → キーでできるすべての操作。右端のサイドシートで、開いたまま操作できる
import type { Command, Section } from '../commands';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import type { Settings } from '../settings';
import './OpsPanel.css';

/** 設定のチェックボックス。キーで変えたときも同じ状態を示す */
export type Toggle = { label: string; checked: boolean; onChange: (v: boolean) => void };

type Props = {
  toggles: Toggle[];
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  quick: Command[];
  sections: Section[];
  onClose: () => void;
};

function Grid({ items }: { items: Command[] }) {
  return (
    <div className="ops-grid">
      {items.map((c) => (
        <button key={c.key + c.label} type="button" className="ops-item" onClick={c.run}>
          <span>{c.label}</span>
          <kbd>{c.key}</kbd>
        </button>
      ))}
    </div>
  );
}

export function OpsPanel(p: Props) {
  return (
    <aside className="ops-panel" data-testid="ops-panel" aria-label={ja.opsPanel}>
      <header className="ops-title">
        <h2>{ja.opsPanel}</h2>
        <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onClick={p.onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="ops-body">
        <section>
          <h3>{ja.settings}</h3>
          {p.toggles.map((t) => (
            <label key={t.label} className="ops-switch">
              <input type="checkbox" checked={t.checked} onChange={(e) => t.onChange(e.target.checked)} />
              {t.label}
            </label>
          ))}
          <fieldset className="ops-radio">
            <legend>{ja.tabbarStyle}</legend>
            {(['top', 'side'] as const).map((v) => (
              <label key={v}>
                <input type="radio" name="tabbar" checked={p.settings.tabbar === v} onChange={() => p.onSettings({ tabbar: v })} />
                {v === 'top' ? ja.tabbarTop : ja.tabbarSide}
              </label>
            ))}
          </fieldset>
        </section>
        {p.quick.length > 0 && (
          <section data-testid="ops-quick">
            <h3>{ja.secQuick}</h3>
            <Grid items={p.quick} />
          </section>
        )}
        <div data-testid="ops-all">
          {p.sections.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <Grid items={s.items} />
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}
