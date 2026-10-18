// フェーズ3の基準3(docs/spec.md 11章): 1080p 60fps の性能。ほかのテストと並べて流すと CPU を取り合って
// アプリ自身の描画まで 30 fps を切り、dew の性能を測れない(2026-10-17: 24 コアで load 33、受信 4 fps・アプリ 28 fps)。
// そのため playwright.config.ts の perf プロジェクトで、ほかのテストがすべて終わってから1つだけ流す。
// 単独で流すとき: npx playwright test --project perf --no-deps
import { appPath, expect, liveBits, liveWindow, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });
const APPEAR = { timeout: 20_000 };

// 受信 fps(復号したフレーム数)と、アプリが描いたフレーム数の両方を出す。落ちたとき、どちらで詰まったかが分かる
test('1080p 60fps で受信 fps 55 以上、遅延 150 ms 以下', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--size', '1920x1080', '--fps', '60', '--tone', '0']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.waitForTimeout(2000); // 立ち上がりを待つ
  // 受信 fps: 復号したフレーム数の増え方
  const decoded = () => win.evaluate((el) => Number(el.getAttribute('data-decoded')));
  const d0 = await decoded();
  const n0 = await liveBits(win, 0, 20);
  const t0 = Date.now();
  await page.waitForTimeout(2000);
  const fps = ((await decoded()) - d0) / 2;
  const appFps = ((await liveBits(win, 0, 20)) - n0) / ((Date.now() - t0) / 1000);
  console.log(`受信 fps: ${fps}、アプリ fps: ${appFps.toFixed(1)}`);
  expect(fps).toBeGreaterThanOrEqual(55);
  // 遅延: アプリが描いた時刻(2段目のブロック)と、表示中の時刻の差の中央値
  const lags: number[] = [];
  for (let i = 0; i < 30; i++) {
    const drawn = await liveBits(win, 1, 32);
    const now = await page.evaluate(() => Date.now() % 2 ** 32);
    lags.push((now - drawn + 2 ** 32) % 2 ** 32);
    await page.waitForTimeout(50);
  }
  lags.sort((a, b) => a - b);
  console.log(`遅延(ms): 中央値 ${lags[Math.floor(lags.length / 2)]}、最小 ${lags[0]}、最大 ${lags.at(-1)}`);
  expect(lags[Math.floor(lags.length / 2)]!).toBeLessThanOrEqual(150);
});

