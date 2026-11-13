// アップロード(spec 19 章)の受け入れ基準
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { current, expect, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

const snackbar = (page: Page) => page.getByRole('status');

/** ファイルの選択画面を横取りしておく。待ち始めてから横取りが効くまでに間があり、
 * キーを押す(すぐ開く)と横取りの前に開いてしまうことがあるため、最初から聞いておく */
async function startWithChooser(page: Page, dew: Parameters<typeof start>[1]) {
  page.on('filechooser', () => {});
  await start(page, dew);
}

/** ページの中で File を作ってドラッグ&ドロップする(dragenter → dragover → drop) */
async function dropFiles(page: Page, files: { name: string; text: string }[], phase: 'drop' | 'hover' = 'drop') {
  await page.evaluate(
    ({ files, phase }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }));
      const fire = (type: string) => document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      if (phase === 'drop') fire('drop');
    },
    { files, phase },
  );
}

// 19: ボタンでファイルを選んで、今のディレクトリへ送る。日本語の名前もそのまま
test('アップロードボタンで選んだファイルを、今のディレクトリに保存する', async ({ page, dew }) => {
  const dir = join(dew.root, 'up');
  mkdirSync(dir);
  writeFileSync(join(dir, 'existing.txt'), 'old\n');
  await startWithChooser(page, dew);
  dew.run([dir]);
  await expect(current(page).getByRole('option', { name: 'existing.txt' })).toBeVisible();

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'アップロード', exact: true }).click()]);
  expect(chooser.isMultiple()).toBe(true);
  // 3 MB のファイルも送れる(本文の大きさに上限を設けていない)
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  await chooser.setFiles([
    { name: '日本語 メモ.md', mimeType: 'text/markdown', buffer: Buffer.from('# メモ\n') },
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big },
  ]);
  await expect(snackbar(page)).toContainText('2 件をアップロードしました');
  expect(readFileSync(join(dir, '日本語 メモ.md'), 'utf8')).toBe('# メモ\n');
  expect(readFileSync(join(dir, 'big.bin')).equals(big)).toBe(true);
  // 一覧に出て、送った最初のファイルにカーソルが合う
  await expect(current(page).getByRole('option', { name: '日本語 メモ.md' })).toHaveAttribute('aria-selected', 'true');
  // 書きかけの隠しファイルは残らない
  expect(readdirSync(dir).filter((n) => n.startsWith('.dew-upload'))).toEqual([]);

  // 同じ名前は上書きせず、番号を付けた名前で保存する。U でもファイルを選べる
  const [again] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('U')]);
  await again.setFiles([{ name: 'existing.txt', mimeType: 'text/plain', buffer: Buffer.from('new\n') }]);
  await expect(snackbar(page)).toContainText('「existing.txt」は「existing (1).txt」として保存しました');
  expect(readFileSync(join(dir, 'existing.txt'), 'utf8')).toBe('old\n');
  expect(readFileSync(join(dir, 'existing (1).txt'), 'utf8')).toBe('new\n');
});

// 19: Home にドラッグ&ドロップしたファイルを送る。置く前は置き場所を案内する
test('Home にドラッグ&ドロップしたファイルを、今のディレクトリに保存する', async ({ page, dew }) => {
  const dir = join(dew.root, 'drop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  await start(page, dew);
  dew.run([dir]);
  await expect(current(page).getByRole('option', { name: 'a.txt' })).toBeVisible();

  await dropFiles(page, [{ name: 'x.txt', text: 'x\n' }], 'hover');
  await expect(page.getByTestId('drop-target')).toContainText(`ここに置くと ${dir} にアップロードします`);
  await dropFiles(page, [
    { name: 'x.txt', text: 'x\n' },
    { name: 'y.csv', text: 'a,b\n1,2\n' },
  ]);
  await expect(page.getByTestId('drop-target')).toHaveCount(0);
  await expect(snackbar(page)).toContainText('2 件をアップロードしました');
  expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('x\n');
  expect(readFileSync(join(dir, 'y.csv'), 'utf8')).toBe('a,b\n1,2\n');
  await expect(current(page).getByRole('option', { name: 'y.csv' })).toBeVisible();

  // キャンバスで置いても送らず、ブラウザもそのファイルへ移らない
  await page.keyboard.press('Tab');
  const url = page.url();
  await dropFiles(page, [{ name: 'z.txt', text: 'z\n' }]);
  await expect(snackbar(page)).toContainText('アップロードは Home で行います');
  expect(page.url()).toBe(url);
  expect(readdirSync(dir)).not.toContain('z.txt');
});

// 19: 範囲の外・使えない名前・書き込めないディレクトリには書かない
test('範囲の外・使えない名前・書き込めないディレクトリには保存しない', async ({ page, dew }) => {
  const ro = join(dew.root, 'readonly');
  mkdirSync(ro);
  await startWithChooser(page, dew);
  const put = (dir: string, name: string) =>
    page.request.put(new URL(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, page.url()).href, { data: 'x' });
  expect((await put('..', 'a.txt')).status()).toBe(403);
  expect((await put(dew.root, '../a.txt')).status()).toBe(400);
  expect((await put(dew.root, '..')).status()).toBe(400);
  chmodSync(ro, 0o555);
  try {
    // root で動かしているときは権限を無視して書けてしまうので、そのときは確かめない
    if (process.getuid?.() !== 0) {
      const r = await put(ro, 'a.txt');
      expect(r.status()).toBe(403);
      expect(await r.text()).toContain('書き込み権限がありません');
    }
  } finally {
    chmodSync(ro, 0o755);
  }
  expect(readdirSync(ro)).toEqual([]);

  // 画面からの失敗も、ファイルごとに知らせる
  chmodSync(ro, 0o555);
  try {
    if (process.getuid?.() !== 0) {
      dew.run([ro]);
      // 中へ移ると、パンくずの末尾が readonly へのリンクになる
      await expect(page.getByRole('navigation', { name: 'path' }).getByRole('link', { name: 'readonly', exact: true })).toBeVisible();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('U')]);
      await chooser.setFiles([{ name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') }]);
      await expect(snackbar(page)).toContainText('「b.txt」をアップロードできません: 書き込み権限がありません');
    }
  } finally {
    chmodSync(ro, 0o755);
  }
});
