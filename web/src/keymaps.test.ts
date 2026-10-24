// キーマップのキーが、キー一覧(?)とヒントの帯に漏れなく載っているかを確かめる
import { describe, expect, test } from 'vitest';
import { normal, windowHelp, windowKeys } from './canvas/Canvas';
import { homeBindings } from './home/Home';
import { ja } from './i18n/ja';

/** 表示に載っている書き方からキーを取り出す('j / k' → j と k、'0–9' → 0〜9、'gg' → 'g g') */
function keysIn(rows: readonly (readonly [string, string])[]): Set<string> {
  const out = new Set<string>();
  for (const [k] of rows) {
    if (k === '/') out.add('/');
    for (const part of k.split(/\s*\/\s*|\s+|,(?=\s)/).filter(Boolean)) {
      const range = /^(\d)–(\d)$/.exec(part);
      if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) out.add(String(n));
      else if (part === 'Space') out.add(' ');
      else if (part === 'gg') out.add('g g');
      else if (part === 'Tab') out.add('Tab');
      else for (const piece of part.split('/')) out.add(piece);
    }
  }
  // 「, .」や「[ ]」のような区切り記号も1つずつのキーとして扱う
  for (const [k] of rows) for (const ch of k) if (',.[]+-='.includes(ch)) out.add(ch);
  return out;
}

/** 一覧に載せなくてよいキー(矢印は j/k/h/l の別名、Esc・Ctrl+[ は抜ける操作の共通キー) */
const ALIASES = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Escape', 'C-[']);

describe('キー一覧に全キーが載っている', () => {
  test.each([
    ['Home', homeBindings, ja.homeKeys],
    ['キャンバス', normal, ja.canvasKeys],
    ['ウィンドウ操作モード', windowKeys, windowHelp],
  ] as const)('%s', (_, bindings, rows) => {
    const listed = keysIn(rows);
    const missing = Object.keys(bindings).filter((k) => !ALIASES.has(k) && !listed.has(k));
    expect(missing).toEqual([]);
  });
});

describe('ヒントの帯に主なキーが載っている', () => {
  test.each([
    ['Home', homeBindings, ja.homeHints],
    // キャンバスの帯はウィンドウの種類で出し分けるので、全部の組を合わせて調べる
    ['キャンバス', normal, Object.values(ja.canvasHints).flat()],
    ['ウィンドウ操作モード', windowKeys, ja.windowHints],
  ] as const)('%s', (_, bindings, rows) => {
    const listed = keysIn(rows);
    const missing = Object.keys(bindings).filter((k) => !ALIASES.has(k) && !listed.has(k));
    expect(missing).toEqual([]);
  });
});
