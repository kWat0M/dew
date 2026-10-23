// CSV の表示の書式(16.3): 列の名前(A, B, … AA)、数値の丸めと桁区切り、コピーする1行
import type { CsvColumn } from '../protocol/CsvColumn';
import type { CsvColumnView } from '../protocol/CsvColumnView';

/** 列番号(0 から)を表計算ソフトと同じ英字に(0 → A、26 → AA) */
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 数値の列か */
export const isNumeric = (c: CsvColumn) => c.ty === 'integer' || c.ty === 'float';

const formats = new Map<string, Intl.NumberFormat>();

/** 表示する文字。丸め・桁区切りは数値の列だけ。元の値は変えない(y でコピーするのは元の値) */
export function display(c: CsvColumn, v: CsvColumnView | undefined, raw: string): string {
  if (!isNumeric(c) || (v?.decimals === undefined && !v?.grouping)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const digits = v.decimals ?? (c.ty === 'float' ? c.decimals : 0);
  const key = `${digits}:${v.grouping}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: v.grouping });
    formats.set(key, f);
  }
  return f.format(n);
}

/** 小数の桁数を1つ増やす・減らす。「そのまま」は列の最大の桁数とみなす(0〜10) */
export function stepDecimals(c: CsvColumn, current: number | undefined, dir: 1 | -1): number {
  const now = current ?? (c.ty === 'float' ? c.decimals : 0);
  return Math.max(0, Math.min(10, now + dir));
}

/** 1行を CSV の1行にする(Y)。区切り文字・引用符・改行を含む値は引用符で囲む */
export function csvLine(values: (string | null)[], delimiter: string): string {
  const d = delimiter === '\\t' ? '\t' : delimiter;
  return values
    .map((v) => {
      const s = v ?? '';
      return s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r') ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(d);
}

/** 3桁ごとにカンマを入れた行数など */
export const count = (n: number) => n.toLocaleString('en-US');

/** 列の既定の幅(型ごと) */
export function defaultWidth(c: CsvColumn): number {
  switch (c.ty) {
    case 'integer':
      return 96;
    case 'float':
      return 120;
    case 'boolean':
      return 80;
    case 'date':
      return 150;
    case 'string':
      return 160;
  }
}
