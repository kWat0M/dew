import { expect, test } from 'vitest';
import { cleanView, compareKeys, compareText, invalidValue, matches, searchHit, sortKey } from './compare';
import type { CsvFilter } from '../protocol/CsvFilter';

const f = (op: CsvFilter['op'], value = '', value2 = ''): CsvFilter => ({ col: 0, op, value, value2 });

test('文字列は小文字にしてコードポイント順(サロゲートは U+E000〜 より後)', () => {
  const keys = ['Beta', 'alpha', 'Über', '\u{1F600}', 'Ａ', 'ab'].map((s) => sortKey('string', s));
  const sorted = [...keys].sort(compareKeys);
  expect(sorted).toEqual(['ab', 'alpha', 'beta', 'über', 'ａ', '\u{1F600}']);
  expect(compareText('a', 'ab')).toBeLessThan(0);
  expect(compareText('￿', '\u{10000}')).toBeLessThan(0);
});

test('数値・真偽値は値で、null は undefined', () => {
  expect(compareKeys(sortKey('float', '10'), sortKey('float', '9.5'))).toBeGreaterThan(0);
  expect(compareKeys(sortKey('integer', '-2'), sortKey('integer', '1'))).toBeLessThan(0);
  expect(compareKeys(sortKey('boolean', 'FALSE'), sortKey('boolean', 'true'))).toBeLessThan(0);
  expect(sortKey('string', null)).toBeUndefined();
});

test('フィルターの条件', () => {
  expect(matches('string', 'Alpha12', f('contains', 'ALP'))).toBe(true);
  expect(matches('string', 'alpha', f('equals', 'ALPHA'))).toBe(true);
  expect(matches('string', 'alpha', f('startsWith', 'lph'))).toBe(false);
  expect(matches('string', null, f('empty'))).toBe(true);
  expect(matches('float', null, f('ne', '1'))).toBe(false);
  expect(matches('float', '1e3', f('gt', '999'))).toBe(true);
  expect(matches('integer', '5', f('between', '5', '6'))).toBe(true);
  expect(matches('date', '2026-10-21', f('lt', '2026-11'))).toBe(true);
  expect(matches('boolean', 'TRUE', f('true'))).toBe(true);
  expect(matches('string', 'drop -- table', f('contains', '--'))).toBe(true);
  expect(invalidValue('float', f('gt', 'abc'))).toBe('number');
  expect(invalidValue('float', f('between', '1', ''))).toBe('number');
  expect(invalidValue('string', f('contains', ''))).toBeNull();
});

test('検索は大文字小文字を区別しない部分一致', () => {
  expect(searchHit("'; DROP TABLE t; --", "'; drop")).toBe(true);
  expect(searchHit(null, 'a')).toBe(false);
  expect(searchHit('abc', '')).toBe(false);
});

test('表にない列や、型で使えない条件を指す表示設定は除く', () => {
  const cols = [
    { name: 'a', ty: 'string', decimals: 0 },
    { name: 'b', ty: 'float', decimals: 2 },
  ] as const;
  const v = {
    options: {},
    sort: [{ col: 1, desc: false }, { col: 5, desc: true }],
    filters: [f('contains'), { ...f('gt', '1'), col: 0 }, { ...f('gt', '1'), col: 1 }],
    search: '',
    columns: [{ col: 9, grouping: false, hidden: true, pinned: false }],
    marks: [],
    rules: [{ col: 3, op: 'empty' as const, value: '', value2: '', color: 'primary' as const }],
    cell: [0, 0] as [number, number],
    scroll: [0, 0] as [number, number],
  };
  const c = cleanView(v, [...cols]);
  expect(c.sort).toEqual([{ col: 1, desc: false }]);
  expect(c.filters.map((x) => [x.col, x.op])).toEqual([[0, 'contains'], [1, 'gt']]);
  expect(c.columns).toEqual([]);
  expect(c.rules).toEqual([]);
  // 直すところがなければ同じもの
  expect(cleanView(c, [...cols])).toBe(c);
});
