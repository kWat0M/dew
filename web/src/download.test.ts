import { describe, expect, it } from 'vitest';
import { zipName } from './download';

describe('zipName', () => {
  it('ディレクトリ1つならその名前、それ以外は日時', () => {
    expect(zipName([{ path: '/w/写真', dir: true }])).toBe('写真.zip');
    expect(zipName([{ path: '/w/写真/', dir: true }])).toBe('写真.zip');
    const now = new Date(2026, 9, 4, 5, 6, 7);
    expect(zipName([{ path: '/w/a', dir: false }, { path: '/w/b', dir: false }], now)).toBe('dew-20261004-050607.zip');
    expect(zipName([{ path: '/w/a', dir: true }, { path: '/w/b', dir: true }], now)).toBe('dew-20261004-050607.zip');
  });
});
