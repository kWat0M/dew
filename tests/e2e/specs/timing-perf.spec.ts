// 時間に厳しい受け入れテスト。ほかのテストと並べて流すと CPU を取り合って揺らぐ(フレーム番号の差が1以内、
// 巻き戻しの位置)ので、playwright.config.ts の timing-* プロジェクトで、ほかのテストと性能のテストの後に流す(ADR 0011)
// 単独で流すとき: npx playwright test --project timing-chrome --project timing-firefox --no-deps
import { type Page } from '@playwright/test';
import { appPath, copyP2, expect, frameNumbersAtOnce, liveBits, liveWindow, pick, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });
const APPEAR = { timeout: 20_000 };

// ---- フェーズ2の基準1: 同期再生 ----

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


// ---- フェーズ4の基準3: 巻き戻し ----

// 基準3: 直近30秒を巻き戻して再生できる
test('直近30秒を巻き戻して再生できる', async ({ page, dew }) => {
  test.setTimeout(90_000);
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0', '--fps', '30']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  const frame = () => liveBits(win, 0, 20);
  // 30秒より長く流してから、一時停止して先頭(30秒前)へ
  await page.waitForTimeout(34_000);
  await page.keyboard.press('k');
  await expect(win).toHaveAttribute('data-paused', 'true');
  const paused = await frame();
  await page.waitForTimeout(500);
  expect(await frame()).toBe(paused); // 止まっている
  await page.keyboard.press('0');
  // 30fps のアプリなので、30秒前はおよそ 900 フレーム前。位置は受け取った時刻で数えるので、負荷が高く
  // フレームがまとまって届くと少しずれる(キーフレームの区切りのぶん古いのもよい)
  await expect.poll(async () => paused - (await frame())).toBeGreaterThanOrEqual(840);
  expect(paused - (await frame())).toBeLessThanOrEqual(1100);
  // 5秒進める(l)と、およそ 150 フレーム進む
  const old = await frame();
  await page.keyboard.press('l');
  await expect.poll(async () => (await frame()) - old).toBeGreaterThanOrEqual(110);
  expect((await frame()) - old).toBeLessThanOrEqual(200);
  // 再生すると、巻き戻した位置から進む
  await page.keyboard.press('k');
  const a = await frame();
  await expect.poll(frame).toBeGreaterThan(a + 20);
  expect(await frame()).toBeLessThan(paused);
  await expect(win).toHaveAttribute('data-rewind', 'playing');
  // マウスでも: 「ライブへ戻る」で今の映像に戻り、一時停止ボタンで止められる
  await win.getByRole('button', { name: 'ライブへ戻る' }).click();
  await expect(win).toHaveAttribute('data-rewind', 'live');
  await expect.poll(frame).toBeGreaterThan(paused + 30);
  await win.locator('.live-bar').getByRole('button', { name: '一時停止' }).click();
  await expect(win).toHaveAttribute('data-paused', 'true');
});
