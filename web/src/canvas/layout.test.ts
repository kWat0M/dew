import { expect, test } from 'vitest';
import { neighbor, tile } from './layout';

test('2つは左右、4つは 2x2', () => {
  const two = tile(2, 1000, 600);
  expect(two[0]!.y).toBe(two[1]!.y);
  expect(two[1]!.x).toBeGreaterThan(two[0]!.x);
  const four = tile(4, 1000, 600);
  expect(new Set(four.map((r) => r.x)).size).toBe(2);
  expect(new Set(four.map((r) => r.y)).size).toBe(2);
});

test('方向の隣', () => {
  const r = tile(4, 1000, 600); // 0 1 / 2 3
  expect(neighbor(r, 0, 'l')).toBe(1);
  expect(neighbor(r, 0, 'j')).toBe(2);
  expect(neighbor(r, 3, 'k')).toBe(1);
  expect(neighbor(r, 3, 'h')).toBe(2);
  expect(neighbor(r, 0, 'h')).toBeNull();
});
