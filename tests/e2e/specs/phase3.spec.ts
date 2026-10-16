// フェーズ3の受け入れ基準(docs/spec.md 11章): ライブ描画。アプリは tests/apps のふつうの GUI アプリで、dew のことを知らない
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPath, expect, liveBits, liveWindow, start, test } from '../lib/dew';

// 起動(Xvfb・pulseaudio・アプリ)に時間がかかるので長めにする
test.describe.configure({ timeout: 60_000 });
const APPEAR = { timeout: 20_000 };

// 基準1: dew run で、コードを変えずにウィンドウがキャンバスに現れる
test('dew run でアプリのウィンドウがキャンバスに現れる', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  // 映像が届いて進んでいる(フレーム番号が増える)
  const first = await liveBits(win, 0, 20);
  await expect.poll(() => liveBits(win, 0, 20)).toBeGreaterThan(first + 10);
});

// 基準2: アプリが2つの窓を開くと、キャンバスに2つのウィンドウが出る
test('2つの窓を開くアプリで2つのウィンドウが出る', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('two_windows.py')]);
  await expect(liveWindow(page, 'left')).toBeVisible(APPEAR);
  await expect(liveWindow(page, 'right')).toBeVisible(APPEAR);
});

// 基準3: 1080p 60fps のテストアプリで、受信 fps が 55 以上、遅延が 150 ms 以下(Chrome で測る)
test.fixme('1080p 60fps で受信 fps 55 以上、遅延 150 ms 以下', async ({ page, dew, browserName }) => {
  test.skip(browserName !== 'chromium', '基準は Chrome で測る');
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--size', '1920x1080', '--fps', '60', '--tone', '0']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.waitForTimeout(2000); // 立ち上がりを待つ
  // 受信 fps: 復号したフレーム数の増え方
  const decoded = () => win.evaluate((el) => Number(el.getAttribute('data-decoded')));
  const d0 = await decoded();
  await page.waitForTimeout(2000);
  const fps = ((await decoded()) - d0) / 2;
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
  expect(lags[Math.floor(lags.length / 2)]!).toBeLessThanOrEqual(150);
});

// 基準4: テストアプリの 440 Hz の音が、ブラウザ側で 440 Hz として検出される
test.fixme('440 Hz の音がブラウザで 440 Hz として検出される', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '440']);
  await expect(liveWindow(page, 'counter')).toBeVisible(APPEAR);
  await page.getByTestId('global-mute').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { dewTest: { audioPeakHz(): number | null } }).dewTest.audioPeakHz()), { timeout: 15_000 })
    .toBeGreaterThan(430);
  const hz = await page.evaluate(() => (window as unknown as { dewTest: { audioPeakHz(): number | null } }).dewTest.audioPeakHz());
  expect(hz!).toBeLessThan(450);
});

// 基準5: 入力モードで押したキーをアプリが受け取り、Ctrl+] で抜けた後のキーは受け取らない
test.fixme('入力モードのキーだけがアプリに届く', async ({ page, dew }) => {
  const keylog = join(mkdtempSync(join(tmpdir(), 'dew-keys-')), 'keys.txt');
  writeFileSync(keylog, '');
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0'], { DEW_TEST_KEYLOG: keylog });
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.waitForTimeout(1000);

  await page.keyboard.press('i');
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.type('abc');
  await expect.poll(() => readFileSync(keylog, 'utf8').split('\n').filter(Boolean)).toEqual(['a', 'b', 'c']);
  await page.keyboard.press('Control+]');
  await expect(win).toHaveAttribute('data-input', 'false');
  await page.keyboard.type('x');
  await page.waitForTimeout(800);
  expect(readFileSync(keylog, 'utf8')).not.toContain('x');
});

// 基準6: cv2.imshow、matplotlib、pygame のサンプルがすべて表示される
test.fixme('cv2・matplotlib・pygame のサンプルが表示される', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('cv2_sample.py')]);
  dew.spawnRun(['python3', appPath('mpl_sample.py')]);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  for (const title of ['cv2 sample', 'Figure 1', 'counter']) await expect(liveWindow(page, title)).toBeVisible(APPEAR);
});
