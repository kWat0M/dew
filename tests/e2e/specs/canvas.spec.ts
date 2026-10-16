// 操作画面の改訂(2026-10-16): ウィンドウ操作モード、複数選択、最小化・最大化、タスクバー、並べ替え
import { type Page } from '@playwright/test';
import { current, expect, start, test } from '../lib/dew';

const FILES = ['h264_aac.mp4', 'image.jpg', 'image.png', 'mp4v.mp4'];

/** Home で4つを Space で選び、Enter でまとめて開く。2x2 のタイル(1 2 / 3 4) */
async function openFour(page: Page) {
  for (const name of FILES) {
    await current(page).getByRole('option', { name }).click();
    await page.keyboard.press(' ');
  }
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player-window')).toHaveCount(4);
}

const win = (page: Page, name: string) => page.getByTestId('player-window').and(page.getByLabel(name, { exact: true }));
const focusedName = (page: Page) => page.locator('[data-testid="player-window"][data-focused="true"]').getAttribute('aria-label');
const paused = (page: Page, name: string) => win(page, name).locator('video').evaluate((v: HTMLVideoElement) => v.paused);
const taskbar = (page: Page) => page.getByTestId('taskbar').getByRole('tab');

test('ウィンドウ操作モードは q で抜けるまで続き、1打鍵ずつ操作できる', async ({ page, dew }) => {
  await start(page, dew);
  await openFour(page);
  expect(await focusedName(page)).toBe('mp4v.mp4');

  await page.keyboard.press('w');
  await expect(page.getByTestId('window-mode')).toBeVisible();
  for (const [key, name] of [['k', 'image.jpg'], ['h', 'h264_aac.mp4'], ['j', 'image.png'], ['l', 'mp4v.mp4'], ['1', 'h264_aac.mp4']]) {
    await page.keyboard.press(key!);
    expect(await focusedName(page)).toBe(name);
  }
  await page.keyboard.press('q');
  await expect(page.getByTestId('window-mode')).toBeHidden();
  // 抜けた後の k は再生 / 一時停止
  await expect.poll(() => paused(page, 'h264_aac.mp4')).toBe(false);
  await page.keyboard.press('k');
  await expect.poll(() => paused(page, 'h264_aac.mp4')).toBe(true);
  expect(await focusedName(page)).toBe('h264_aac.mp4');
});

test('選んだ全ウィンドウに再生のキーが効き、X で全部閉じる', async ({ page, dew }) => {
  await start(page, dew);
  await openFour(page);
  await expect.poll(() => paused(page, 'mp4v.mp4')).toBe(false);

  await page.keyboard.press('w');
  await page.keyboard.press('1');
  await page.keyboard.press(' ');
  await page.keyboard.press('4');
  await page.keyboard.press(' ');
  await page.keyboard.press('q');
  await expect(page.locator('[data-testid="player-window"][data-selected="true"]')).toHaveCount(2);

  await page.keyboard.press('k');
  await expect.poll(() => paused(page, 'h264_aac.mp4')).toBe(true);
  await expect.poll(() => paused(page, 'mp4v.mp4')).toBe(true);

  // マウスのチェックボックスでも選べる。a で全選択 / 解除
  await win(page, 'image.png').getByRole('checkbox').click();
  await expect(page.locator('[data-testid="player-window"][data-selected="true"]')).toHaveCount(3);
  await page.keyboard.press('w');
  await page.keyboard.press('a');
  await expect(page.locator('[data-testid="player-window"][data-selected="true"]')).toHaveCount(4);
  await page.keyboard.press('a');
  await expect(page.locator('[data-testid="player-window"][data-selected="true"]')).toHaveCount(0);

  await page.keyboard.press('X');
  await expect(page.getByTestId('player-window')).toHaveCount(0);
});

test('最小化したウィンドウはタスクバーから戻り、最大化は元の位置に戻せる', async ({ page, dew }) => {
  await start(page, dew);
  await openFour(page);
  const first = win(page, 'h264_aac.mp4');
  const before = await first.boundingBox();

  await first.getByRole('button', { name: '最小化' }).click();
  await expect(first).toBeHidden();
  await expect(win(page, 'image.jpg')).toBeVisible();
  await taskbar(page).filter({ hasText: 'h264_aac.mp4' }).click();
  await expect(first).toBeVisible();
  expect(await focusedName(page)).toBe('h264_aac.mp4');
  // フォーカス中のタブを押すと最小化する(Windows のタスクバーと同じ)
  await taskbar(page).filter({ hasText: 'h264_aac.mp4' }).click();
  await expect(first).toBeHidden();
  await taskbar(page).filter({ hasText: 'h264_aac.mp4' }).click();

  await first.getByRole('button', { name: '最大化' }).click();
  const area = await page.getByTestId('canvas-area').boundingBox();
  const max = await first.boundingBox();
  expect(max!.width).toBeGreaterThan(area!.width - 4);
  await first.getByRole('button', { name: '元に戻す' }).click();
  expect(await first.boundingBox()).toEqual(before);
});

test('タイル配置でタイトルバーをドラッグすると並び順と番号が入れ替わる', async ({ page, dew }) => {
  await start(page, dew);
  await openFour(page);
  const from = await win(page, 'h264_aac.mp4').getByTestId('window-title').boundingBox();
  const to = await win(page, 'mp4v.mp4').boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(taskbar(page)).toHaveText([/1.*mp4v\.mp4/, /2.*image\.jpg/, /3.*image\.png/, /4.*h264_aac\.mp4/]);

  // 配置の切替はボタンでもできる
  await page.getByRole('button', { name: 'タイル配置' }).click();
  await expect(page.getByRole('button', { name: '自由配置' })).toBeVisible();
});
