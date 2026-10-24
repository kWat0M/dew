// キー操作の見直し(2026-10-24、ADR 0030)の受け入れ基準: 抜けるキー(Esc・Ctrl+[・q)、CSV の小さな画面のキー操作、
// Home のプレビューのクリック、キャンバスのノーマルモード / 操作モード / 入力モード、マウスでの操作モード
import { choose, csvWindow, goCol, openCsv, status } from '../lib/csv';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { appPath, copyCsv, copyMd, current, expect, liveWindow, selected, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

// 文字を打つ欄は Esc・Ctrl+[ で欄から抜けるだけ。欄は残り、もう一度押すと閉じる
test('Home の絞り込みは Esc で欄から抜け、もう一度 Esc で解除する', async ({ page, dew }) => {
  await start(page, dew);
  await expect(current(page).getByRole('option').first()).toBeVisible();
  const all = await current(page).getByRole('option').count();
  await page.keyboard.press('/');
  const box = page.locator('input.filter');
  await expect(box).toBeFocused();
  await page.keyboard.type('image');
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();
  await expect(current(page).getByRole('option')).toHaveCount(2);
  // 欄の外ではキーマップが効く
  await page.keyboard.press('G');
  await expect(current(page).getByRole('option', { selected: true })).toHaveAttribute('data-name', 'image.png');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(current(page).getByRole('option')).toHaveCount(all);
  // Ctrl+[ も Esc と同じ
  await page.keyboard.press('/');
  await page.keyboard.type('jpg');
  await page.keyboard.press('Control+BracketLeft');
  await expect(box).not.toBeFocused();
  await expect(current(page).getByRole('option')).toHaveCount(1);
});

test('CSV の検索欄は Esc・Ctrl+[ で欄から抜け、もう一度押すと閉じる', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await page.keyboard.press('/');
  const box = win.getByRole('textbox', { name: '検索' });
  await expect(box).toBeFocused();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Control+BracketLeft');
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();
  // 欄の外では表のキーが効く
  await page.keyboard.press('j');
  await expect(status(win)).toContainText('A2');
  // / で欄に戻る
  await page.keyboard.press('/');
  await expect(box).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(csvWindow(page, 'rows10k.csv')).toHaveAttribute('data-op', 'true');
});

// CSV の小さな画面は、欄を hjkl・矢印で選び、Enter で入る(選択欄は一覧を開き、j / k で選んで Enter)
test('フィルターの画面を hjkl と Enter だけで操作する', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await goCol(page, win, 2);
  await page.keyboard.press('f');
  const dialog = page.getByRole('dialog', { name: /フィルター/ });
  // 開いた直後は値の欄に入っていて、すぐ打てる
  const value = dialog.getByLabel('値');
  await expect(value).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(value).not.toBeFocused();
  await expect(dialog).toBeVisible();
  // k で条件の欄へ、Enter で一覧を開いて j で「>」へ
  await page.keyboard.press('k');
  const op = dialog.getByRole('combobox', { name: '条件' });
  await expect(op).toBeFocused();
  await page.keyboard.press('Enter');
  const list = page.getByRole('listbox', { name: '条件' });
  await expect(list).toBeVisible();
  for (let i = 0; i < 4; i++) await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(op).toHaveText('>');
  // j で値の欄へ、Enter で入って打ち、Enter で適用
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(value).toBeFocused();
  await page.keyboard.type('0');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(win.getByTestId('csv-rows')).not.toHaveText(/^10,000 \/ 10,000 行/);
});

test('強調の画面を矢印と Enter だけで操作し、Esc で1段ずつ閉じる', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await goCol(page, win, 1);
  await page.keyboard.press('M');
  const dialog = page.getByRole('dialog', { name: '条件付き強調' });
  const add = dialog.getByRole('button', { name: 'ルールを足す' });
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('combobox', { name: '強調 1' })).toBeVisible();
  // 上の行(ルール)へ移り、左へ動いて値の欄に入る
  await page.keyboard.press('ArrowUp');
  const value = dialog.getByRole('textbox', { name: '値' });
  for (let i = 0; i < 4 && !(await value.evaluate((el) => el.parentElement === document.activeElement)); i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(value).toBeFocused();
  await page.keyboard.type('alpha');
  await expect(win.locator('.csv-tr[class*="rule-"]').first()).toBeVisible();
  // Esc で欄から抜け、もう一度 Esc で画面を閉じる。CSV の操作モードは続く
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(csvWindow(page, 'rows10k.csv')).toHaveAttribute('data-op', 'true');
});

// Home の右カラム(ディレクトリの中身)は押して開ける: ディレクトリはその中へ、ファイルはキャンバスで
test('Home の右カラムのディレクトリとファイルを押して開く', async ({ page, dew }) => {
  mkdirSync(join(dew.root, 'sub/inner'));
  writeFileSync(join(dew.root, 'sub/inner/note.md'), '# note\n');
  await start(page, dew);
  await current(page).getByRole('option', { name: 'sub' }).click();
  const preview = page.getByTestId('col-preview');
  // ディレクトリ: 2階層下がり、押したディレクトリが左のカラムで選ばれる
  await preview.locator('li[data-name="inner"]').click();
  await expect(page.getByTestId('col-parent').getByRole('option', { selected: true })).toHaveText('inner');
  await expect(current(page).getByRole('option', { name: 'note.md' })).toBeVisible();
  await expect(page).toHaveURL(/\/home\/.*\/sub\/inner$/);
  // ブラウザの戻るで元の場所へ
  await page.goBack();
  await expect.poll(() => selected(page)).toBe('sub');
  // ファイル: 選んでいたディレクトリへ移り、そのファイルを選んでキャンバスで開く
  await preview.locator('li[data-name="nested.webp"]').click();
  await expect(page.getByTestId('player-window').filter({ hasText: 'nested.webp' })).toBeVisible();
  await expect(page).toHaveURL(/\/canvas$/);
  await page.goBack();
  await expect(page.getByTestId('col-parent').getByRole('option', { selected: true })).toHaveText('sub');
  await expect.poll(() => selected(page)).toBe('nested.webp');
});

// ---- キャンバス: ノーマルモード / 操作モード / 入力モード(5.1、ADR 0030) ----

/** Home で Space で選んだファイルをまとめて開く。最後のウィンドウが操作モードで開く */
async function openMany(page: Page, names: string[]) {
  await expect(current(page).getByRole('option').first()).toBeVisible();
  for (const name of names) {
    await current(page).getByRole('option', { name, exact: true }).click();
    await page.keyboard.press(' ');
  }
  await page.keyboard.press('Enter');
  for (const name of names) await expect(page.getByTestId('player-window').filter({ hasText: name })).toBeVisible();
}
const player = (page: Page, name: string) => page.getByTestId('player-window').filter({ hasText: name });
const playing = (win: Locator) => win.locator('video').evaluate((v: HTMLVideoElement) => !v.paused);
const body = (win: Locator) => win.locator('.window-body');
/** 開くと自動で再生が始まるので、確かめる前に止める */
const pause = (...wins: Locator[]) => Promise.all(wins.map((w) => w.locator('video').evaluate((v: HTMLVideoElement) => v.pause())));

test('ノーマルモードの hjkl でウィンドウを選び、i / Enter で操作モード、Esc・q・Ctrl+[ で抜ける', async ({ page, dew }) => {
  await start(page, dew);
  await openMany(page, ['h264_aac.mp4', 'mp4v.mp4']);
  const [a, b] = [player(page, 'h264_aac.mp4'), player(page, 'mp4v.mp4')];
  // 開いた直後は操作モード
  await expect(b).toHaveAttribute('data-op', 'true');
  await page.keyboard.press('Escape');
  await expect(b).toHaveAttribute('data-op', 'false');
  // h は Home へ戻らず、左のウィンドウを選ぶ
  await page.keyboard.press('h');
  await expect(a).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('col-current')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(b).toHaveAttribute('data-focused', 'true');
  // ノーマルモードの k は再生しない
  await pause(a, b);
  await page.keyboard.press('k');
  expect(await playing(b)).toBe(false);
  // Enter で操作モードに入り、k で再生する。q で抜ける
  await page.keyboard.press('Enter');
  await expect(b).toHaveAttribute('data-op', 'true');
  await page.keyboard.press('k');
  await expect.poll(() => playing(b)).toBe(true);
  await page.keyboard.press('k');
  await page.keyboard.press('q');
  await expect(b).toHaveAttribute('data-op', 'false');
  await page.keyboard.press('i');
  await expect(b).toHaveAttribute('data-op', 'true');
  await page.keyboard.press('Control+BracketLeft');
  await expect(b).toHaveAttribute('data-op', 'false');
  // Tab はいつも Home へ
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('col-current')).toBeVisible();
});

test('枠の色はフォーカス・操作モード・入力モードで変わる', async ({ page, dew }) => {
  const keylog = join(mkdtempSync(join(tmpdir(), 'dew-keys-')), 'keys.txt');
  writeFileSync(keylog, '');
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0'], { DEW_TEST_KEYLOG: keylog });
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible({ timeout: 20_000 });
  const border = () => win.evaluate((el) => getComputedStyle(el).borderTopColor);
  // ライブも、出てきたときは操作モード(tokyonight day の緑)。i で入力モード(紫)、Ctrl+[ で操作モードへ戻り、Esc でフォーカスだけ(青)
  await expect(win).toHaveAttribute('data-op', 'true');
  await expect.poll(border).toBe('rgb(88, 117, 57)');
  await page.keyboard.press('i');
  await expect(win).toHaveAttribute('data-input', 'true');
  await expect.poll(border).toBe('rgb(152, 84, 241)');
  // 入力モードの Esc はアプリへ送る
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(keylog, 'utf8')).toContain('\x1b');
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.press('Control+BracketLeft');
  await expect(win).toHaveAttribute('data-input', 'false');
  await expect(win).toHaveAttribute('data-op', 'true');
  await page.keyboard.press('Escape');
  await expect(win).toHaveAttribute('data-op', 'false');
  await expect.poll(border).toBe('rgb(46, 125, 233)');
});

test('マウス: 本体を押すと操作モード、動画は2回目で再生。ウィンドウの外を押すと抜ける', async ({ page, dew }) => {
  await start(page, dew);
  await openMany(page, ['h264_aac.mp4', 'mp4v.mp4']);
  const [a, b] = [player(page, 'h264_aac.mp4'), player(page, 'mp4v.mp4')];
  await page.keyboard.press('Escape');
  await pause(a, b);
  // 1回目で操作モード(再生しない)、2回目で再生
  await body(a).click();
  await expect(a).toHaveAttribute('data-op', 'true');
  expect(await playing(a)).toBe(false);
  await body(a).click();
  await expect.poll(() => playing(a)).toBe(true);
  await body(a).click();
  await expect.poll(() => playing(a)).toBe(false);
  // 別のウィンドウを押すと、そちらの操作モードへ
  await body(b).click();
  await expect(a).toHaveAttribute('data-op', 'false');
  await expect(b).toHaveAttribute('data-op', 'true');
  // タイトルバーはフォーカスだけ
  await a.getByTestId('window-title').click();
  await expect(a).toHaveAttribute('data-focused', 'true');
  await expect(a).toHaveAttribute('data-op', 'false');
  await expect(b).toHaveAttribute('data-op', 'false');
  // ヒントの帯・タブバーを押すと抜ける
  await body(b).click();
  await expect(b).toHaveAttribute('data-op', 'true');
  await page.getByTestId('hint-bar').filter({ visible: true }).locator('.hint').first().click();
  await expect(b).toHaveAttribute('data-op', 'false');
  await body(b).click();
  await page.getByTestId('taskbar').getByRole('tab').first().click();
  await expect(a).toHaveAttribute('data-focused', 'true');
  await expect(b).toHaveAttribute('data-op', 'false');
  await expect(a).toHaveAttribute('data-op', 'false');
});

test('画像の操作モード: + で拡大し、hjkl で表示位置を動かす', async ({ page, dew }) => {
  await start(page, dew);
  await openMany(page, ['image.png']);
  const img = player(page, 'image.png').locator('img');
  await expect(img).toBeVisible();
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  const x0 = (await img.boundingBox())!.x;
  await page.keyboard.press('h');
  await expect.poll(async () => (await img.boundingBox())!.x).toBeGreaterThan(x0 + 40);
});

/** w で選択する: フォーカス中を選び、h で左へ移ってそれも選ぶ */
async function selectTwo(page: Page) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('w');
  await page.keyboard.press(' ');
  await page.keyboard.press('h');
  await page.keyboard.press(' ');
  await page.keyboard.press('q');
}

test('選択した Markdown をまとめて操作する。f のヒントは全ウィンドウで重ならない', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  for (const name of ['a.md', 'all.md']) {
    dew.run([join(dew.root, 'md', name)]);
    await expect(page.getByTestId('document-window').and(page.getByLabel(name, { exact: true })).getByTestId('doc-body')).toBeVisible();
  }
  const wins = page.getByTestId('document-window');
  await selectTwo(page);
  await page.keyboard.press('i');
  await expect(wins.nth(0)).toHaveAttribute('data-op', 'true');
  await expect(wins.nth(1)).toHaveAttribute('data-op', 'true');
  // j で両方スクロールする
  await page.keyboard.press('j');
  for (const i of [0, 1]) await expect.poll(() => wins.nth(i).getByTestId('doc-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // f のヒントは両方に出て、文字が重ならない
  await page.keyboard.press('f');
  const hints = page.getByTestId('link-hint');
  await expect(wins.nth(0).getByTestId('link-hint').first()).toBeVisible();
  await expect(wins.nth(1).getByTestId('link-hint').first()).toBeVisible();
  const labels = await hints.allTextContents();
  expect(new Set(labels).size).toBe(labels.length);
  // Esc でヒントを閉じ、もう一度 Esc で操作モードを抜ける
  await page.keyboard.press('Escape');
  await expect(hints).toHaveCount(0);
  await expect(wins.nth(0)).toHaveAttribute('data-op', 'true');
  await page.keyboard.press('Escape');
  await expect(wins.nth(0)).toHaveAttribute('data-op', 'false');
  await expect(wins.nth(1)).toHaveAttribute('data-op', 'false');
});

test('選択した CSV をまとめて操作する。型が合わないウィンドウには適用せずに知らせる', async ({ page, dew }) => {
  const dir = copyCsv(dew, ['rows10k.csv', 'quoted.csv']);
  cpSync(join(dir, 'rows10k.csv'), join(dir, 'rows10k-b.csv'));
  await start(page, dew);
  const a = await openCsv(page, dew, 'rows10k.csv');
  const b = await openCsv(page, dew, 'rows10k-b.csv');
  await selectTwo(page);
  await page.keyboard.press('i');
  await expect(a).toHaveAttribute('data-op', 'true');
  await expect(b).toHaveAttribute('data-op', 'true');
  // カーソルの移動と並べ替えは両方に効く
  await page.keyboard.press('j');
  await page.keyboard.press('l');
  for (const w of [a, b]) await expect(status(w)).toContainText('B2');
  await page.keyboard.press('s');
  for (const w of [a, b]) await expect(w.locator('[role="columnheader"][data-col="1"]')).toHaveAttribute('aria-sort', 'ascending');
  // フィルターの画面はフォーカス中のウィンドウだけに出し、決めた条件は両方に付く
  await page.keyboard.press('f');
  await expect(page.getByRole('dialog', { name: /フィルター/ })).toHaveCount(1);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  for (const w of [a, b]) await expect(w.getByTestId('csv-rows')).not.toHaveText(/^10,000 \/ 10,000 行/);
  await page.keyboard.press('Escape');

  // 列の型が合わないウィンドウ(文字列の列に数の比較)は飛ばして知らせる
  // 選択を1番目(rows10k.csv)と3番目(quoted.csv)にし、1番目から操作モードに入る
  const q = await openCsv(page, dew, 'quoted.csv');
  await page.keyboard.press('Escape');
  for (const key of ['w', 'a', 'a', '3', ' ', '1', ' ', 'q', 'i']) await page.keyboard.press(key);
  await expect(q).toHaveAttribute('data-op', 'true');
  await expect(b).toHaveAttribute('data-op', 'false');
  // rows10k.csv は数値の列(score)、quoted.csv は文字列の列(text)へ
  await page.keyboard.press('l');
  await page.keyboard.press('f');
  const dialog = page.getByRole('dialog', { name: /フィルター/ });
  await choose(page, dialog, '条件', 'gt');
  await dialog.getByLabel('値').fill('0');
  await dialog.getByLabel('値').press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '1 個のウィンドウでは適用できませんでした' })).toBeVisible();
});

test('選択したライブウィンドウにまとめてキーを送る', async ({ page, dew }) => {
  const logs = [0, 1].map(() => join(mkdtempSync(join(tmpdir(), 'dew-keys-')), 'keys.txt'));
  for (const l of logs) writeFileSync(l, '');
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0'], { DEW_TEST_KEYLOG: logs[0]! });
  await expect(liveWindow(page, 'counter')).toHaveCount(1, { timeout: 20_000 });
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0'], { DEW_TEST_KEYLOG: logs[1]! });
  const wins = liveWindow(page, 'counter');
  await expect(wins).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(1000);
  await selectTwo(page);
  await page.keyboard.press('i');
  await page.keyboard.press('i');
  for (const i of [0, 1]) await expect(wins.nth(i)).toHaveAttribute('data-input', 'true');
  await page.keyboard.type('ab');
  for (const l of logs) await expect.poll(() => readFileSync(l, 'utf8').split('\n').filter(Boolean)).toEqual(['a', 'b']);
  await page.keyboard.press('Control+BracketLeft');
  for (const i of [0, 1]) await expect(wins.nth(i)).toHaveAttribute('data-input', 'false');
});
