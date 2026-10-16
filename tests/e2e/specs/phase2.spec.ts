// フェーズ2の受け入れ基準(docs/spec.md 11章): 比較・画像
import { join } from 'node:path';
import { type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { copyP2, current, expect, frameNumbersAtOnce, open, pixelOf, start, test } from '../lib/dew';

/** Home で Ctrl+クリックして選ぶ */
async function pick(page: Page, names: string[]) {
  for (const name of names) await current(page).getByRole('option', { name }).click({ modifiers: ['Control'] });
}

/** 要素の中の相対位置(0–1)の画素の色を、画面のスクリーンショットから読む */
async function colorAt(page: Page, el: Locator, fx: number, fy: number) {
  const box = (await el.boundingBox())!;
  const png = PNG.sync.read(await page.screenshot());
  const x = Math.round(box.x + box.width * fx);
  const y = Math.round(box.y + box.height * fy);
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
}
const isWhite = (c: number[]) => c.every((v) => v > 230);
const isBlack = (c: number[]) => c.every((v) => v < 25);

/** 両方が再生していて、どちらも 10 秒を過ぎるまで待つ(素材は 15 秒) */
async function playTenSeconds(page: Page) {
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.isConnected && v.offsetParent).every((v) => !v.paused)), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => Math.min(...[...document.querySelectorAll('video')].filter((v) => v.offsetParent).map((v) => v.currentTime))), { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(10);
}

// 基準1: 2本の動画を同期再生し、10秒後のフレーム番号の差が1以内(キャンバスの s)
test('キャンバスの s で2本を同期再生する', async ({ page, dew }) => {
  test.setTimeout(60_000);
  copyP2(dew, ['long_h264.mp4', 'long_mp4v.mp4']);
  await start(page, dew);
  await pick(page, ['long_h264.mp4', 'long_mp4v.mp4']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player-window')).toHaveCount(2);
  // わざと位置をずらしてから同期する
  await page.keyboard.press('3');
  await page.keyboard.press('s');
  await expect(page.getByTestId('sync-indicator')).toBeVisible();
  await page.keyboard.press('0');
  await playTenSeconds(page);
  const [a, b] = await frameNumbersAtOnce(page);
  expect(Math.abs(a! - b!)).toBeLessThanOrEqual(1);
});

// 基準1(比較ウィンドウ): Home の c で比較ウィンドウを開き、並べて同期再生する
test('比較ウィンドウで2本を同期再生する', async ({ page, dew }) => {
  test.setTimeout(60_000);
  copyP2(dew, ['long_h264.mp4', 'long_mp4v.mp4']);
  await start(page, dew);
  await pick(page, ['long_h264.mp4', 'long_mp4v.mp4']);
  await page.keyboard.press('c');
  const win = page.getByTestId('compare-window');
  await expect(win).toBeVisible();
  await expect(win.locator('video')).toHaveCount(2);
  await playTenSeconds(page);
  const [a, b] = await frameNumbersAtOnce(page);
  expect(Math.abs(a! - b!)).toBeLessThanOrEqual(1);
});

// 基準2: スライダー比較が動く
test('スライダー比較で境目より左は1つ目、右は2つ目が見える', async ({ page, dew }) => {
  copyP2(dew, ['image_b.png']);
  await start(page, dew);
  await pick(page, ['image.png', 'image_b.png']);
  await page.keyboard.press('c');
  const win = page.getByTestId('compare-window');
  await win.getByRole('radio', { name: 'スライダー' }).click();
  const stage = win.getByTestId('compare-stage');
  const media = win.getByTestId('compare-media');
  // image_b.png は (400,200)-(480,260) を白く塗ってある。中心は横 0.6875、縦 0.639
  const box = await stage.boundingBox();
  const handle = win.getByTestId('compare-handle');
  const drag = async (fx: number) => {
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * fx, h.y + h.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  await drag(0.25);
  expect(isWhite(await colorAt(page, media, 0.6875, 0.639))).toBe(true);
  await drag(0.95);
  expect(isWhite(await colorAt(page, media, 0.6875, 0.639))).toBe(false);
});

// 基準2: 差分表示が動く
test('差分表示で違うところだけが明るく出る', async ({ page, dew }) => {
  copyP2(dew, ['image_b.png']);
  await start(page, dew);
  await pick(page, ['image.png', 'image_b.png']);
  await page.keyboard.press('c');
  const win = page.getByTestId('compare-window');
  await win.getByRole('radio', { name: '差分' }).click();
  const media = win.getByTestId('compare-media');
  await expect.poll(async () => isBlack(await colorAt(page, media, 0.2, 0.3))).toBe(true);
  expect(isBlack(await colorAt(page, media, 0.6875, 0.639))).toBe(false);
});

// 基準3: 画像の等倍表示で、指定したピクセルの値が元画像と一致する
test.fixme('等倍表示でピクセルの値が元画像と一致する', async ({ page, dew }) => {
  await start(page, dew);
  await open(page, 'image.png');
  await page.keyboard.press('z');
  const img = page.getByTestId('player-window').locator('img');
  const box = (await img.boundingBox())!;
  expect(Math.round(box.width)).toBe(640);
  for (const [x, y] of [[100, 50], [5, 300], [639, 359]] as const) {
    await page.mouse.move(box.x + x + 0.5, box.y + y + 0.5);
    const [r, g, b] = pixelOf(join(dew.root, 'image.png'), x, y);
    await expect(page.getByTestId('pixel-info')).toHaveText(`x ${x}, y ${y}  R ${r} G ${g} B ${b} A 255`);
  }
});

// F8 / 2.6: 16bit PNG と TIFF も表示でき、16bit は元の値を出す
test.fixme('16bit PNG と TIFF を表示し、16bit は元の値を出す', async ({ page, dew }) => {
  copyP2(dew, ['image16.png', 'image.tif']);
  await start(page, dew);
  await open(page, 'image.tif');
  await expect.poll(() => page.getByTestId('player-window').locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  await page.keyboard.press('h');
  await open(page, 'image16.png');
  const win = page.getByTestId('player-window').filter({ hasText: 'image16.png' });
  await page.keyboard.press('z');
  const img = win.locator('img');
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + 100.5, box.y + 50.5);
  const [r, g, b] = pixelOf(join(dew.root, 'image16.png'), 100, 50, 16);
  await expect(win.getByTestId('pixel-info')).toHaveText(`x 100, y 50  R ${r} G ${g} B ${b} A 65535`);
});
