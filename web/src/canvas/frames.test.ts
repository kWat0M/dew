import { expect, test } from 'vitest';
import { frameAt, frameFrom, seekTimeFor } from './frames';

const times = Array.from({ length: 300 }, (_, i) => i / 30);

test('時刻からフレーム番号', () => {
  expect(frameAt(times, 0)).toBe(0);
  expect(frameAt(times, 1 / 30 - 1e-4)).toBe(1); // 浮動小数のゆらぎ
  expect(frameAt(times, 0.05)).toBe(1);
  expect(frameAt(times, 5)).toBe(150);
  expect(frameAt(times, 100)).toBe(299);
  expect(frameAt([], 1)).toBe(0);
});

test('可変フレームレート', () => {
  const vfr = [0, 0.1, 0.15, 0.4];
  expect(frameAt(vfr, 0.2)).toBe(2);
  expect(seekTimeFor(vfr, 2, 1)).toBeCloseTo(0.2125);
  expect(frameAt(vfr, seekTimeFor(vfr, 3, 1))).toBe(3);
});

test('移動先', () => {
  expect(frameFrom(times, 5)).toBe(150);
  expect(frameFrom(times, 5.01)).toBe(151);
  for (let n = 0; n < 300; n++) expect(frameAt(times, seekTimeFor(times, n, 10))).toBe(n);
});
