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

// 基準4: テストアプリの 440 Hz の音が、ブラウザ側で 440 Hz として検出される
test('440 Hz の音がブラウザで 440 Hz として検出される', async ({ page, dew }) => {
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
test('入力モードのキーだけがアプリに届く', async ({ page, dew }) => {
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
test('cv2・matplotlib・pygame のサンプルが表示される', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('cv2_sample.py')]);
  dew.spawnRun(['python3', appPath('mpl_sample.py')]);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  for (const title of ['cv2 sample', 'Figure 1', 'counter']) await expect(liveWindow(page, title)).toBeVisible(APPEAR);
});

// 5.5: I の送信用の入力欄から、文字列をまとめて送れる(Shift が要る文字も押した文字どおりに届く)
test('I の入力欄から文字列を送れる', async ({ page, dew }) => {
  const keylog = join(mkdtempSync(join(tmpdir(), 'dew-keys-')), 'keys.txt');
  writeFileSync(keylog, '');
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0'], { DEW_TEST_KEYLOG: keylog });
  await expect(liveWindow(page, 'counter')).toBeVisible(APPEAR);
  await page.waitForTimeout(1000);
  await page.keyboard.press('I');
  const box = page.getByRole('dialog', { name: '文字列を送る' }).getByRole('textbox');
  await box.fill('Hi!');
  await box.press('Enter');
  // 大文字や記号では、実際のキーボードと同じく Shift も押される(アプリには Shift キーの押下も届く)
  await expect
    .poll(() => readFileSync(keylog, 'utf8').split('\n').filter((k) => k && !k.includes('shift')))
    .toEqual(['H', 'i', '!']);
});

// 7.9: w r で、アプリのウィンドウの大きさが表示領域(ディスプレイの画素)に合い、新しい大きさの映像が続けて届く
test('w r でアプリの大きさが表示領域に合う', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0', '--resizable']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await expect(win.locator('.live-bar')).toContainText('640×360');
  const size = await win.locator('.window-body').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * devicePixelRatio), h: Math.round(r.height * devicePixelRatio) };
  });
  await page.keyboard.press('w');
  await page.keyboard.press('r');
  await page.keyboard.press('q');
  // H.264 のため、映像の大きさは偶数に切り上がる
  await expect(win.locator('.live-bar')).toContainText(`${size.w + (size.w % 2)}×${size.h + (size.h % 2)}`, APPEAR);
  // 作り直した映像が届き続けている(フレーム番号が増える)
  const first = await liveBits(win, 0, 20);
  await expect.poll(() => liveBits(win, 0, 20)).toBeGreaterThan(first + 10);
});
