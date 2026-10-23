// CSV のウィンドウの中に重ねて出す小さな画面: フィルター・表示名・行番号・セルの全文・条件付き強調・表示設定(16.3〜16.7)。
// どれも閉じるボタンがあり、文字を打つ欄では Enter で確定、Esc で閉じる
import { useState, type ReactNode } from 'react';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import type { CsvColor } from '../protocol/CsvColor';
import type { CsvColumn } from '../protocol/CsvColumn';
import type { CsvColumnView } from '../protocol/CsvColumnView';
import type { CsvFilter } from '../protocol/CsvFilter';
import type { CsvFilterOp } from '../protocol/CsvFilterOp';
import type { CsvOptions } from '../protocol/CsvOptions';
import type { CsvRule } from '../protocol/CsvRule';
import type { CsvSchema } from '../protocol/CsvSchema';
import type { TextEncoding } from '../protocol/TextEncoding';
import { needsValue, opsFor } from './compare';
import { isNumeric } from './format';

const C = ja.csv;
const COLORS: CsvColor[] = ['primary', 'secondary', 'tertiary', 'error'];
const MAX_RULES = 4;

function Panel({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`csv-panel${wide ? ' wide' : ''}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      ref={(el) => {
        // 文字を打つ欄がなければ、パネル自体にフォーカスして Esc などを受ける
        if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('input, select') ?? el).focus();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape' || (e.target === e.currentTarget && ['Enter', 'q', 'Backspace'].includes(e.key))) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="csv-panel-title">
        <h3>{title}</h3>
        <button type="button" className="icon-button small" title={ja.close} aria-label={ja.close} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      {children}
    </div>
  );
}

/** Enter で確定する文字の欄 */
function Field({ label, value, onChange, onEnter }: { label: string; value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <label className="csv-field">
      <span>{label}</span>
      <input
        type="text"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </label>
  );
}

function OpSelect({ ty, value, onChange }: { ty: CsvColumn['ty']; value: CsvFilterOp; onChange: (op: CsvFilterOp) => void }) {
  return (
    <label className="csv-field">
      <span>{C.op}</span>
      <select aria-label={C.op} value={value} onChange={(e) => onChange(e.target.value as CsvFilterOp)}>
        {opsFor(ty).map((op) => (
          <option key={op} value={op}>
            {C.ops[op]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterDialog({
  column,
  label,
  current,
  onApply,
  onClose,
}: {
  column: CsvColumn;
  label?: string;
  current?: CsvFilter;
  onApply: (f: Omit<CsvFilter, 'col'> | null) => void;
  onClose: () => void;
}) {
  const [op, setOp] = useState<CsvFilterOp>(current?.op ?? opsFor(column.ty)[0]!);
  const [value, setValue] = useState(current?.value ?? '');
  const [value2, setValue2] = useState(current?.value2 ?? '');
  const apply = () => onApply({ op, value: needsValue(op) ? value : '', value2: op === 'between' ? value2 : '' });
  return (
    <Panel title={C.filter(label ?? column.name)} onClose={onClose}>
      <OpSelect ty={column.ty} value={op} onChange={setOp} />
      <Field label={C.value} value={value} onChange={setValue} onEnter={apply} />
      {op === 'between' && <Field label={C.value2} value={value2} onChange={setValue2} onEnter={apply} />}
      <div className="csv-panel-actions">
        {current && (
          <button type="button" className="text-button" onClick={() => onApply(null)}>
            {C.clear}
          </button>
        )}
        <button type="button" className="filled-button" onClick={apply}>
          {C.apply}
        </button>
      </div>
    </Panel>
  );
}

export function RenameDialog({ name, label, onApply, onClose }: { name: string; label?: string; onApply: (label: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(label ?? '');
  return (
    <Panel title={C.labelTitle(name)} onClose={onClose}>
      <Field label={C.label} value={value} onChange={setValue} onEnter={() => onApply(value.trim())} />
      <div className="csv-panel-actions">
        <button type="button" className="filled-button" onClick={() => onApply(value.trim())}>
          {C.apply}
        </button>
      </div>
    </Panel>
  );
}

export function JumpDialog({ onApply, onClose }: { onApply: (row: number) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const apply = () => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) onApply(n);
  };
  return (
    <Panel title={C.jump} onClose={onClose}>
      <Field label={C.jump} value={value} onChange={setValue} onEnter={apply} />
    </Panel>
  );
}

export function InspectorDialog({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Panel title={C.inspector} onClose={onClose} wide>
      <pre className="csv-inspector" data-testid="csv-inspector">
        {text}
      </pre>
    </Panel>
  );
}

export function RulesDialog({
  columns,
  rules,
  current,
  onChange,
  onMessage,
  onClose,
}: {
  columns: CsvColumn[];
  rules: CsvRule[];
  /** 足すルールの列(選択中の列) */
  current: number;
  onChange: (rules: CsvRule[]) => void;
  onMessage: (m: string) => void;
  onClose: () => void;
}) {
  const set = (i: number, r: Partial<CsvRule>) => onChange(rules.map((x, j) => (j === i ? { ...x, ...r } : x)));
  return (
    <Panel title={C.rules} onClose={onClose} wide>
      {rules.map((r, i) => {
        const c = columns[r.col]!;
        return (
          <div key={i} className="csv-rule">
            <select aria-label={`${C.rules} ${i + 1}`} value={r.col} onChange={(e) => {
              const col = Number(e.target.value);
              set(i, { col, op: opsFor(columns[col]!.ty)[0]! });
            }}>
              {columns.map((x, j) => (
                <option key={j} value={j}>
                  {x.name}
                </option>
              ))}
            </select>
            <OpSelect ty={c.ty} value={r.op} onChange={(op) => set(i, { op })} />
            {needsValue(r.op) && <input type="text" aria-label={C.value} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />}
            {r.op === 'between' && <input type="text" aria-label={C.value2} value={r.value2} onChange={(e) => set(i, { value2: e.target.value })} />}
            <select aria-label={C.color} value={r.color} className={`csv-swatch rule-${r.color}`} onChange={(e) => set(i, { color: e.target.value as CsvColor })}>
              {COLORS.map((x) => (
                <option key={x} value={x}>
                  {C.colors[x]}
                </option>
              ))}
            </select>
            <button type="button" className="icon-button small" title={C.clear} aria-label={C.clear} onClick={() => onChange(rules.filter((_, j) => j !== i))}>
              <Icon name="close" size={18} />
            </button>
          </div>
        );
      })}
      <div className="csv-panel-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (rules.length >= MAX_RULES) return onMessage(C.rulesMax);
            onChange([...rules, { col: current, op: opsFor(columns[current]!.ty)[0]!, value: '', value2: '', color: COLORS[rules.length % COLORS.length]! }]);
          }}
        >
          {C.addRule}
        </button>
      </div>
    </Panel>
  );
}

export function SettingsDialog({
  schema,
  options,
  column,
  view,
  onOptions,
  onColumn,
  onReset,
  onClose,
}: {
  schema: CsvSchema;
  options: CsvOptions;
  column?: CsvColumn;
  view?: CsvColumnView;
  onOptions: (o: CsvOptions) => void;
  onColumn: (f: (v: CsvColumnView) => CsvColumnView) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const auto = (v: string, detected: string) => `${ja.detected}: ${v || detected}`;
  return (
    <Panel title={C.settings} onClose={onClose} wide>
      <label className="csv-field">
        <span>{C.encoding}</span>
        <select aria-label={C.encoding} value={options.encoding ?? ''} onChange={(e) => onOptions({ ...options, encoding: (e.target.value || undefined) as TextEncoding | undefined })}>
          <option value="">{auto('', ja.encodings[schema.detected])}</option>
          {(['utf8', 'shiftJis', 'eucJp'] as const).map((x) => (
            <option key={x} value={x}>
              {ja.encodings[x]}
            </option>
          ))}
        </select>
      </label>
      <label className="csv-field">
        <span>{C.delimiter}</span>
        <select aria-label={C.delimiter} value={options.delimiter ?? ''} onChange={(e) => onOptions({ ...options, delimiter: e.target.value || undefined })}>
          <option value="">{auto('', C.delimiters[schema.delimiter] ?? schema.delimiter)}</option>
          {Object.entries(C.delimiters).map(([d, name]) => (
            <option key={d} value={d}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="csv-check">
        <input type="checkbox" checked={options.header ?? schema.header} onChange={(e) => onOptions({ ...options, header: e.target.checked })} />
        {C.header}
      </label>
      {column && isNumeric(column) && (
        <>
          <label className="csv-field">
            <span>{C.decimals}</span>
            <select aria-label={C.decimals} value={view?.decimals ?? ''} onChange={(e) => onColumn((v) => ({ ...v, decimals: e.target.value === '' ? undefined : Number(e.target.value) }))}>
              <option value="">{C.asIs}</option>
              {Array.from({ length: 11 }, (_, i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
          <label className="csv-check">
            <input type="checkbox" checked={view?.grouping ?? false} onChange={(e) => onColumn((v) => ({ ...v, grouping: e.target.checked }))} />
            {C.grouping}
          </label>
        </>
      )}
      <div className="csv-panel-actions">
        <button type="button" className="text-button" onClick={onReset}>
          {C.reset}
        </button>
      </div>
    </Panel>
  );
}
