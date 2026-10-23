// CSV の値の比べ方とフィルターの条件(16.4)。大規模モードの SQL(crates/server/src/csv/sql.rs)と同じ決まりにして、
// 両モードの結果(並び順を含む)をそろえる:
// - 数値・真偽値は値の大小(false < true)、日付は ISO 8601 の文字列のまま、文字列は小文字にしてコードポイント順
// - 空のセル(null)は昇順・降順とも末尾。同じ値の行は元の行番号の順
// - 文字列の条件と検索は大文字小文字を区別しない部分一致など。正規表現は使わない
import type { CsvFilter } from '../protocol/CsvFilter';
import type { CsvFilterOp } from '../protocol/CsvFilterOp';
import type { CsvType } from '../protocol/CsvType';

/** 並べ替えに使う値。null は undefined(TanStack Table の sortUndefined: 'last' で末尾に置く) */
export type SortKey = number | string | undefined;

export function sortKey(ty: CsvType, raw: string | null): SortKey {
  if (raw === null) return undefined;
  switch (ty) {
    case 'integer':
    case 'float':
      return Number(raw);
    case 'boolean':
      return raw.toLowerCase() === 'true' ? 1 : 0;
    case 'date':
      return raw;
    case 'string':
      return raw.toLowerCase();
  }
}

/** UTF-16 の符号単位を、コードポイント順と同じ大小になるように置き換える(サロゲートは U+E000〜 より後) */
function unit(c: number): number {
  return c < 0xd800 ? c : c < 0xe000 ? c + 0x2000 : c - 0x800;
}

/** コードポイント順(DuckDB の文字列の比較と同じ。JS の < は UTF-16 の順なので使わない) */
export function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return unit(x) - unit(y);
  }
  return a.length - b.length;
}

export function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b);
  return 0;
}

/** 列の型で選べる条件(フィルターの画面に出す順) */
export function opsFor(ty: CsvType): CsvFilterOp[] {
  switch (ty) {
    case 'integer':
    case 'float':
    case 'date':
      return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'empty', 'notEmpty'];
    case 'boolean':
      return ['true', 'false', 'empty'];
    case 'string':
      return ['contains', 'equals', 'startsWith', 'empty', 'notEmpty'];
  }
}

/** 値を入れない条件 */
export function needsValue(op: CsvFilterOp): boolean {
  return !['empty', 'notEmpty', 'true', 'false'].includes(op);
}

/** 条件の値が、その列で比べられる形か。だめなら理由(数値の列に数値でない値など) */
export function invalidValue(ty: CsvType, f: CsvFilter): 'number' | null {
  if (!needsValue(f.op) || (ty !== 'integer' && ty !== 'float')) return null;
  const ok = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));
  return ok(f.value) && (f.op !== 'between' || ok(f.value2)) ? null : 'number';
}

/** 1つのセルが条件に合うか。null は empty だけに合う(SQL の比較と同じく、ne でも外れる) */
export function matches(ty: CsvType, raw: string | null, f: CsvFilter): boolean {
  if (f.op === 'empty') return raw === null;
  if (f.op === 'notEmpty') return raw !== null;
  if (raw === null) return false;
  switch (f.op) {
    case 'contains':
      return raw.toLowerCase().includes(f.value.toLowerCase());
    case 'equals':
      return raw.toLowerCase() === f.value.toLowerCase();
    case 'startsWith':
      return raw.toLowerCase().startsWith(f.value.toLowerCase());
    case 'true':
      return raw.toLowerCase() === 'true';
    case 'false':
      return raw.toLowerCase() === 'false';
  }
  // 数値は数として、日付は文字列のまま比べる
  const num = ty === 'integer' || ty === 'float';
  const cmp = (v: string) => (num ? Math.sign(Number(raw) - Number(v)) : Math.sign(compareText(raw, v)));
  switch (f.op) {
    case 'eq':
      return cmp(f.value) === 0;
    case 'ne':
      return cmp(f.value) !== 0;
    case 'lt':
      return cmp(f.value) < 0;
    case 'le':
      return cmp(f.value) <= 0;
    case 'gt':
      return cmp(f.value) > 0;
    case 'ge':
      return cmp(f.value) >= 0;
    case 'between':
      return cmp(f.value) >= 0 && cmp(f.value2) <= 0;
  }
  return false;
}

/** 検索に一致するセルか(大文字小文字を区別しない部分一致) */
export function searchHit(raw: string | null, query: string): boolean {
  return raw !== null && query !== '' && raw.toLowerCase().includes(query.toLowerCase());
}
