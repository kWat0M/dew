import { expect, test } from 'vitest';
import { compareKeys, compareText, invalidValue, matches, searchHit, sortKey } from './compare';
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
