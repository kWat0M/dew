// 操作パネル(4.4): キーでできるすべての操作をボタンで並べる。右端のサイドシートで、開いたまま操作できる
import type { Section } from '../commands';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import type { Settings } from '../settings';
import './OpsPanel.css';

type Props = {
  sections: Section[];
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onClose: () => void;
};

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
        {p.sections.map((s) => (
          <section key={s.title}>
            <h3>{s.title}</h3>
            <div className="ops-grid">
              {s.items.map((c) => (
                <button key={c.key + c.label} type="button" className="ops-item" onClick={c.run}>
                  <span>{c.label}</span>
                  <kbd>{c.key}</kbd>
                </button>
              ))}
            </div>
          </section>
        ))}
        <section>
          <h3>{ja.settings}</h3>
          <label className="ops-switch">
            <input type="checkbox" checked={p.settings.hints} onChange={(e) => p.onSettings({ hints: e.target.checked })} />
            {ja.showHints}
          </label>
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
      </div>
    </aside>
  );
}
