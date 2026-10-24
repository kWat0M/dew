// フェーズ8(テーマ・スマホの画面・ダウンロード。spec 18 章)の受け入れ基準
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Download, Page } from '@playwright/test';
import { current, expect, pick, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

const LIGHT_SURFACE = '#faf8ff';
const DARK_SURFACE = '#121318';
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function chooseTheme(page: Page, label: string) {
  await page.getByRole('button', { name: '操作パネル' }).click();
  await page.getByTestId('theme').getByText(label, { exact: true }).click();
  await page.getByRole('button', { name: '操作パネル' }).click();
}

// 18.1: ライト・ダークに固定でき、読み直しても最初の描画から選んだ色で出る
test('テーマをライト・ダーク・ブラウザに合わせるで切り替えられる', async ({ page, dew }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await start(page, dew);
  expect(await token(page, '--md-sys-color-surface')).toBe(LIGHT_SURFACE);

  await chooseTheme(page, 'ダーク');
  await expect.poll(() => token(page, '--md-sys-color-surface')).toBe(DARK_SURFACE);
  expect(await token(page, '--dew-frame-focus')).toBe('#7aa2f7');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');

  // 読み直しても、画面のスクリプトを読む前からダーク(index.html のスクリプトが付ける)
  await page.route('**/assets/*.js', (r) => r.abort());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await token(page, '--md-sys-color-surface')).toBe(DARK_SURFACE);
  await page.unroute('**/assets/*.js');

  // ブラウザに合わせると、ブラウザの設定で変わる
  await start(page, dew);
  await chooseTheme(page, 'ブラウザに合わせる');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await token(page, '--md-sys-color-surface')).toBe(LIGHT_SURFACE);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await token(page, '--md-sys-color-surface')).toBe(DARK_SURFACE);

  // ブラウザがダークでも、ライトに固定できる
  await chooseTheme(page, 'ライト');
  await expect.poll(() => token(page, '--md-sys-color-surface')).toBe(LIGHT_SURFACE);
  expect(await token(page, '--dew-frame-focus')).toBe('#2e7de9');
});

/** 保存したファイル。zip なら中のパスと中身(python3 の zipfile で読む) */
async function saved(download: Download) {
  const path = await download.path();
  return { name: download.suggestedFilename(), path };
}
function zipEntries(path: string): Record<string, string> {
  const script = 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({n: z.read(n).decode("utf-8","replace") for n in z.namelist()}))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, path], { encoding: 'utf8' })) as Record<string, string>;
}
async function press(page: Page, key: string) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.keyboard.press(key)]);
  return saved(d);
}

// 18.3: 1つのファイルはそのまま、ディレクトリと複数は zip。範囲の外は保存しない
test('ファイル・ディレクトリ・選んだ複数を保存できる', async ({ page, dew }) => {
  const dir = join(dew.root, 'dl');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, '日本語 メモ.md'), '# メモ\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  writeFileSync(join(dir, 'sub', 'a.csv'), 'x,y\n1,2\n');
  const outside = mkdtempSync(join(tmpdir(), 'dew-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'sub', 'secret.txt'));
  symlinkSync(outside, join(dir, 'out'));

  await start(page, dew);
  dew.run([dir]);
  const md = current(page).getByRole('option', { name: '日本語 メモ.md' });
  await expect(md).toBeVisible();

  // ファイル1つは D でそのまま。日本語の名前も崩れない
  await md.click();
  const one = await press(page, 'D');
  expect(one.name).toBe('日本語 メモ.md');
  expect(readFileSync(one.path, 'utf8')).toBe('# メモ\n');

  // ディレクトリは zip。範囲の外を指すリンクは入らない
  await current(page).getByRole('option', { name: 'sub' }).click();
  const sub = await press(page, 'D');
  expect(sub.name).toBe('sub.zip');
  expect(zipEntries(sub.path)).toEqual({ 'sub/': '', 'sub/a.csv': 'x,y\n1,2\n' });

  // Space で選んだ複数はまとめて zip
  await pick(page, ['b.txt', '日本語 メモ.md']);
  const many = await press(page, 'D');
  expect(many.name).toMatch(/^dew-\d{8}-\d{6}\.zip$/);
  expect(zipEntries(many.path)).toEqual({ 'b.txt': 'b\n', '日本語 メモ.md': '# メモ\n' });
  await page.keyboard.press('Escape');

  // 範囲の外は 403
  for (const url of ['/api/download?path=..', `/api/download?path=${encodeURIComponent(join(dir, 'out', 'secret.txt'))}`, '/api/download/size?path=..']) {
    expect((await page.request.get(new URL(url, page.url()).href)).status(), url).toBe(403);
  }

  // キャンバス: タイトルバーのボタンと、ノーマルモードの D
  await md.dblclick();
  const win = page.getByTestId('document-window');
  await expect(win.getByTestId('doc-body')).toBeVisible();
  const [d] = await Promise.all([page.waitForEvent('download'), win.getByRole('button', { name: '保存', exact: true }).click()]);
  expect(d.suggestedFilename()).toBe('日本語 メモ.md');
  await page.keyboard.press('Escape');
  expect((await press(page, 'D')).name).toBe('日本語 メモ.md');
});

// 18.3: 合計が 1 GB を超えるときは、保存する前に確かめる(合計の応答を差し替えて確かめる)
test('大きな zip は保存する前に確かめる', async ({ page, dew }) => {
  const dir = join(dew.root, 'big');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'a.txt'), 'a');
  await page.route('**/api/download/size?*', (r) => r.fulfill({ json: { bytes: 2 * 1024 ** 3, files: 12345 } }));
  await start(page, dew);
  dew.run([dir]);
  await current(page).getByRole('option', { name: 'sub' }).click();
  await page.keyboard.press('D');
  const dialog = page.getByRole('dialog', { name: '大きなファイルの保存' });
  await expect(dialog).toContainText('2.0 GB');
  await expect(dialog).toContainText('12,345 ファイル');
  // キャンセルでは保存しない
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press('D');
  const [d] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: '保存する' }).click()]);
  expect(d.suggestedFilename()).toBe('sub.zip');
});
