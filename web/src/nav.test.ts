import { expect, test } from 'vitest';
import { placeOfUrl, urlOf, type Place } from './nav';

test('場所と URL を行き来できる', () => {
  const places: Place[] = [
    { screen: 'home', dir: null },
    { screen: 'home', dir: '/' },
    { screen: 'home', dir: '/home/dev/my project' },
    { screen: 'home', dir: '/a/?#%/日本語' },
    { screen: 'canvas', focus: null },
  ];
  for (const p of places) expect(placeOfUrl(new URL(urlOf(p), 'https://x').pathname)).toEqual(p);
});

test('キャンバスのウィンドウは URL に入れない', () => {
  expect(urlOf({ screen: 'canvas', focus: 3, doc: { win: 3, index: 1 } })).toBe('/canvas');
});

test('知らない URL や壊れた符号化は Home の初期位置', () => {
  expect(placeOfUrl('/open')).toEqual({ screen: 'home', dir: null });
  expect(placeOfUrl('/home/%E3')).toEqual({ screen: 'home', dir: null });
});
