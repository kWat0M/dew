// CSV のウィンドウの中に重ねて出す小さな画面: フィルター・表示名・行番号・セルの全文・条件付き強調・表示設定(16.3〜16.7)。
// どれも閉じるボタンがあり、マウスでもキーでも操作できる: 欄は hjkl・矢印で選んで Enter で入り、文字の欄では Enter で確定、
// Esc・Ctrl+[ で欄から抜ける。欄の外では Esc・Ctrl+[・q で閉じる
import { useState, type ReactNode } from 'react';
import { ja } from '../i18n/ja';
import { isLeaveKey, leavesInput, readKey } from '../keys';
import { isTyping } from '../useKeys';
import { Icon } from '../icons';
import { MenuSelect } from '../ui/MenuSelect';
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

/** 画面の中で hjkl・矢印で動かせる欄(data-nav)を、見た目の位置で探す */
const NAV: Record<string, 'h' | 'j' | 'k' | 'l'> = { h: 'h', j: 'j', k: 'k', l: 'l', ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l' };

function navItems(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>('[data-nav]')].filter((el) => el.getClientRects().length > 0).map((el) => ({ el, r: el.getBoundingClientRect() }));
}

/** from から dir の方向の欄へ。h / l は同じ行の隣、j / k は上下の一番近い行で、横の位置が一番近い欄 */
function moveFocus(panel: HTMLElement, from: HTMLElement | null, dir: 'h' | 'j' | 'k' | 'l') {
  const items = navItems(panel);
  const cur = items.find((i) => i.el === from);
  if (!cur) return items[0]?.el.focus();
  const sameRow = (r: DOMRect) => r.top < cur.r.bottom - 4 && r.bottom > cur.r.top + 4;
  const cx = cur.r.left + cur.r.width / 2;
  let next: (typeof items)[number] | undefined;
  if (dir === 'h' || dir === 'l') {
    next = items
      .filter((i) => i.el !== cur.el && sameRow(i.r) && (dir === 'l' ? i.r.left >= cur.r.right - 1 : i.r.right <= cur.r.left + 1))
      .sort((a, b) => (dir === 'l' ? a.r.left - b.r.left : b.r.right - a.r.right))[0];
  } else {
    const down = dir === 'j';
    const others = items.filter((i) => !sameRow(i.r) && (down ? i.r.top >= cur.r.bottom - 4 : i.r.bottom <= cur.r.top + 4));
    if (!others.length) return;
    const edge = down ? Math.min(...others.map((i) => i.r.top)) : Math.max(...others.map((i) => i.r.bottom));
    next = others
      .filter((i) => (down ? i.r.top < edge + 8 : i.r.bottom > edge - 8))
      .sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0];
  }
  next?.el.focus();
}

/**
 * 重ねて出す小さな画面。欄は hjkl・矢印で選び、Enter で入る(文字の欄なら打てるように、選択欄なら一覧を開く)。
 * 文字の欄からは Esc・Ctrl+[ で抜けるだけ。欄の外では Esc・Ctrl+[・q で画面を閉じる。
 * start が edit なら、最初の文字の欄に入った状態で開く(すぐ打てるように)
 */
function Panel({ title, onClose, children, wide, start = 'nav' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; start?: 'edit' | 'nav' }) {
  return (
    <div
      className={`csv-panel${wide ? ' wide' : ''}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      ref={(el) => {
        if (!el || el.contains(document.activeElement)) return;
        const first = start === 'edit' ? el.querySelector<HTMLElement>('input[type="text"]') : el.querySelector<HTMLElement>('[data-nav]');
        (first ?? el).focus();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        const panel = e.currentTarget;
        const t = e.target as HTMLElement;
        const stop = () => {
          e.preventDefault();
          e.stopPropagation();
        };
        if (isTyping(t)) {
          // 文字を打つ欄からは抜けるだけ(画面は閉じない)
          if (!leavesInput(e.nativeEvent)) return;
          stop();
          return (t.closest<HTMLElement>('[data-nav]') ?? panel).focus();
        }
        const k = readKey(e.nativeEvent);
        if (!k) return;
        const dir = NAV[k.key];
        if (dir) {
          stop();
          return moveFocus(panel, t === panel ? null : t, dir);
        }
        if (isLeaveKey(k.key) || (t === panel && k.key === 'Backspace')) {
          stop();
          return onClose();
        }
        if (k.key !== 'Enter') return;
        // 文字の欄に入る(カーソルは末尾に)
        const input = t.matches('[data-nav]') ? t.querySelector<HTMLInputElement>('input[type="text"]') : null;
        if (input) {
          stop();
          input.focus();
          return input.setSelectionRange(input.value.length, input.value.length);
        }
        if (t instanceof HTMLInputElement && t.type === 'checkbox') {
          stop();
          return t.click();
        }
        if (t === panel) {
          stop();
          onClose();
        }
        // ボタンはブラウザが Enter で押す
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

/** 文字の欄。hjkl で選び、Enter で打てるようになる。打っている間の Enter は onEnter(なければ欄から抜ける) */
function Field({ label, value, onChange, onEnter, inline }: { label: string; value: string; onChange: (v: string) => void; onEnter?: () => void; inline?: boolean }) {
  return (
    <label className={`csv-field${inline ? ' inline' : ''}`} data-nav="" tabIndex={0}>
      <span>{label}</span>
      <input
        type="text"
        tabIndex={-1}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          if (onEnter) onEnter();
          else e.currentTarget.closest<HTMLElement>('[data-nav]')?.focus();
        }}
      />
    </label>
  );
}

/** 選択欄に名前を添える */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="csv-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

function OpSelect({ ty, value, onChange }: { ty: CsvColumn['ty']; value: CsvFilterOp; onChange: (op: CsvFilterOp) => void }) {
  return <MenuSelect label={C.op} value={value} options={opsFor(ty).map((op) => ({ value: op, label: C.ops[op] }))} onChange={onChange} />;
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
    <Panel title={C.filter(label ?? column.name)} onClose={onClose} start="edit">
      <Labeled label={C.op}>
        <OpSelect ty={column.ty} value={op} onChange={setOp} />
      </Labeled>
      {needsValue(op) && <Field label={C.value} value={value} onChange={setValue} onEnter={apply} />}
      {op === 'between' && <Field label={C.value2} value={value2} onChange={setValue2} onEnter={apply} />}
      <div className="csv-panel-actions">
        {current && (
          <button type="button" className="text-button" data-nav="" onClick={() => onApply(null)}>
            {C.clear}
          </button>
        )}
        <button type="button" className="filled-button" data-nav="" onClick={apply}>
          {C.apply}
        </button>
      </div>
    </Panel>
  );
}

export function RenameDialog({ name, label, onApply, onClose }: { name: string; label?: string; onApply: (label: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(label ?? '');
  return (
    <Panel title={C.labelTitle(name)} onClose={onClose} start="edit">
      <Field label={C.label} value={value} onChange={setValue} onEnter={() => onApply(value.trim())} />
      <div className="csv-panel-actions">
        <button type="button" className="filled-button" data-nav="" onClick={() => onApply(value.trim())}>
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
    <Panel title={C.jump} onClose={onClose} start="edit">
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
  const colOptions = columns.map((x, j) => ({ value: j, label: x.name }));
  const colorOptions = COLORS.map((x) => ({ value: x, label: C.colors[x], className: `csv-swatch rule-${x}` }));
  return (
    <Panel title={C.rules} onClose={onClose} wide>
      {rules.map((r, i) => {
        const c = columns[r.col];
        // 列がない(列の少ないファイルの設定)ルールは出さない
        if (!c) return null;
        return (
          <div key={i} className="csv-rule">
            <MenuSelect
              label={`${C.rules} ${i + 1}`}
              value={r.col}
              options={colOptions}
              onChange={(col) => set(i, { col, op: opsFor(columns[col]!.ty)[0]! })}
            />
            <OpSelect ty={c.ty} value={r.op} onChange={(op) => set(i, { op })} />
            {needsValue(r.op) && <Field inline label={C.value} value={r.value} onChange={(value) => set(i, { value })} />}
            {r.op === 'between' && <Field inline label={C.value2} value={r.value2} onChange={(value2) => set(i, { value2 })} />}
            <MenuSelect label={C.color} value={r.color} options={colorOptions} className={`csv-swatch rule-${r.color}`} onChange={(color) => set(i, { color })} />
            <button type="button" className="icon-button small" data-nav="" title={C.clear} aria-label={C.clear} onClick={() => onChange(rules.filter((_, j) => j !== i))}>
              <Icon name="close" size={18} />
            </button>
          </div>
        );
      })}
      <div className="csv-panel-actions">
        <button
          type="button"
          className="text-button"
          data-nav=""
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
  const auto = (v: string) => `${ja.detected}: ${v}`;
  return (
    <Panel title={C.settings} onClose={onClose} wide>
      <Labeled label={C.encoding}>
        <MenuSelect
          label={C.encoding}
          value={options.encoding ?? ''}
          options={[{ value: '', label: auto(ja.encodings[schema.detected]) }, ...(['utf8', 'shiftJis', 'eucJp'] as const).map((x) => ({ value: x, label: ja.encodings[x] }))]}
          onChange={(x) => onOptions({ ...options, encoding: (x || undefined) as TextEncoding | undefined })}
        />
      </Labeled>
      <Labeled label={C.delimiter}>
        <MenuSelect
          label={C.delimiter}
          value={options.delimiter ?? ''}
          options={[{ value: '', label: auto(C.delimiters[schema.delimiter] ?? schema.delimiter) }, ...Object.entries(C.delimiters).map(([d, name]) => ({ value: d, label: name }))]}
          onChange={(x) => onOptions({ ...options, delimiter: x || undefined })}
        />
      </Labeled>
      <label className="csv-check">
        <input type="checkbox" data-nav="" checked={options.header ?? schema.header} onChange={(e) => onOptions({ ...options, header: e.target.checked })} />
        {C.header}
      </label>
      {column && isNumeric(column) && (
        <>
          <Labeled label={C.decimals}>
            <MenuSelect
              label={C.decimals}
              value={view?.decimals ?? -1}
              options={[{ value: -1, label: C.asIs }, ...Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) }))]}
              onChange={(x) => onColumn((v) => ({ ...v, decimals: x < 0 ? undefined : x }))}
            />
          </Labeled>
          <label className="csv-check">
            <input type="checkbox" data-nav="" checked={view?.grouping ?? false} onChange={(e) => onColumn((v) => ({ ...v, grouping: e.target.checked }))} />
            {C.grouping}
          </label>
        </>
      )}
      <div className="csv-panel-actions">
        <button type="button" className="text-button" data-nav="" onClick={onReset}>
          {C.reset}
        </button>
      </div>
    </Panel>
  );
}
