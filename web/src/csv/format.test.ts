import { expect, test } from 'vitest';
import { columnLetter, csvLine, display, stepDecimals } from './format';
import type { CsvColumn } from '../protocol/CsvColumn';

const score: CsvColumn = { name: 'score', ty: 'float', decimals: 6 };

test('列の英字', () => {
  expect([0, 2, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'C', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('丸めと桁区切りは表示だけ', () => {
  expect(display(score, undefined, '-123.456789')).toBe('-123.456789');
  expect(display(score, { col: 2, decimals: 2, grouping: false, hidden: false, pinned: false }, '-1234.456789')).toBe('-1234.46');
  expect(display(score, { col: 2, grouping: true, hidden: false, pinned: false }, '1234.5')).toBe('1,234.500000');
  expect(display({ name: 'n', ty: 'string', decimals: 0 }, { col: 0, decimals: 1, grouping: true, hidden: false, pinned: false }, '1234')).toBe('1234');
  expect(stepDecimals(score, undefined, -1)).toBe(5);
  expect(stepDecimals(score, 10, 1)).toBe(10);
  expect(stepDecimals(score, 0, -1)).toBe(0);
});

test('コピーする1行は、必要な値だけ引用符で囲む', () => {
  expect(csvLine(['a', 'b,c', 'say "hi"', null, '1\n2'], ',')).toBe('a,"b,c","say ""hi""",,"1\n2"');
  expect(csvLine(['a', 'b'], '\\t')).toBe('a\tb');
});
