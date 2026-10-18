// 直近のフレームの持ち方(L7): 先頭はキーフレーム、30秒より少し長めに持つ
import { describe, expect, test } from 'vitest';
import { KEEP_US, LiveBuffer } from './liveRewind';

/** 30fps、1秒ごとにキーフレームのフレームを sec 秒ぶん入れる */
function filled(sec: number) {
  const b = new LiveBuffer();
  for (let i = 0; i < sec * 30; i++) b.push({ key: i % 30 === 0, ts: i * 33_333, data: new Uint8Array() });
  return b;
}

describe('LiveBuffer', () => {
  test('キーフレームから始まる', () => {
    const b = new LiveBuffer();
    b.push({ key: false, ts: 0, data: new Uint8Array() });
    expect(b.chunks).toHaveLength(0);
    b.push({ key: true, ts: 1, data: new Uint8Array() });
    expect(b.chunks).toHaveLength(1);
  });

  test('30秒より古いものは、キーフレームの区切りで捨てる', () => {
    const b = filled(40);
    const span = b.end - b.start;
    expect(span).toBeGreaterThanOrEqual(KEEP_US);
    expect(span).toBeLessThan(KEEP_US + 1_100_000);
    expect(b.chunks[0]!.key).toBe(true);
  });

  test('ある時刻の表示に要るフレームは、直前のキーフレームから', () => {
    const b = filled(5);
    const frames = b.framesFor(2_500_000);
    expect(frames[0]!.key).toBe(true);
    expect(frames[0]!.ts).toBe(60 * 33_333);
    expect(frames.at(-1)!.ts).toBeLessThanOrEqual(2_500_000);
    expect(b.framesFor(-1)).toHaveLength(0);
  });
});
