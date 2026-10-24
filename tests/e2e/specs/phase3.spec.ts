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

// 7.6: アプリの音はそのアプリのウィンドウの音になり、ウィンドウが複数あるときはフォーカス中のウィンドウの音だけが鳴る(ADR 0013)
test('ライブウィンドウの音はフォーカス中のウィンドウだけ鳴る', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '440', '--title', 'low']);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '660', '--title', 'high']);
  const low = liveWindow(page, 'low');
  const high = liveWindow(page, 'high');
  await expect(low).toBeVisible(APPEAR);
  await expect(high).toBeVisible(APPEAR);
  await page.getByTestId('global-mute').click();
  const peak = () => page.evaluate(() => (window as unknown as { dewTest: { audioPeakHz(): number | null } }).dewTest.audioPeakHz() ?? 0);
  const near = (hz: number) => async () => Math.abs((await peak()) - hz) < 10;
  await low.click();
  await expect.poll(near(440), { timeout: 15_000 }).toBe(true);
  await high.click();
  await expect.poll(near(660), { timeout: 15_000 }).toBe(true);
  await low.click();
  await expect.poll(near(440), { timeout: 15_000 }).toBe(true);
});

// 7.9: 親からはみ出した一時的な窓が、ほかのアプリのウィンドウの映像に映り込まない(重なったウィンドウをよける。ADR 0012)
test('はみ出した一時的な窓がほかのウィンドウに映り込まない', async ({ page, dew }) => {
  await start(page, dew);
  // 親(400x300)を先に置き、その右隣に counter を置いてから、右下にはみ出す緑の窓(親の (320, 260)、160x80)を出す
  dew.spawnRun(['python3', appPath('popup.py'), '--outside', '--delay', '4']);
  await expect(liveWindow(page, 'popup')).toBeVisible(APPEAR);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  const counter = liveWindow(page, 'counter');
  await expect(counter).toBeVisible(APPEAR);
  const rgb = (x: number, y: number) =>
    counter.locator('canvas').evaluate((c: HTMLCanvasElement, [x, y]) => [...c.getContext('2d')!.getImageData(x, y, 1, 1).data.slice(0, 3)], [x, y] as const);
  const isGreen = ([r, g, b]: number[]) => g! > 200 && r! < 80 && b! < 80;
  // 緑の窓が出たあと(4秒後)も、counter の左端のあたりに緑が映らない
  await page.waitForTimeout(6000);
  for (let i = 0; i < 10; i++) {
    for (const [x, y] of [[8, 280], [24, 300], [8, 330]] as const) expect(isGreen(await rgb(x, y))).toBe(false);
    await page.waitForTimeout(100);
  }
});

// 7.9: キャンバスで閉じると、デスクトップの × と同じくアプリに閉じるよう頼む(pygame は終わり、matplotlib は図を閉じて終わる)
test('閉じるボタンでアプリに閉じるよう頼む', async ({ page, dew }) => {
  await start(page, dew);
  const apps = [
    { title: 'counter', child: dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']) },
    { title: 'Figure 1', child: dew.spawnRun(['python3', appPath('mpl_sample.py')]) },
  ];
  for (const { title, child } of apps) {
    const win = liveWindow(page, title);
    await expect(win).toBeVisible(APPEAR);
    await page.waitForTimeout(500);
    await win.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(win).toHaveCount(0);
    // dew run はアプリの終了コードを返す(アプリが自分で終わった)
    await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
  }
});

// 基準5: 入力モードで押したキーをアプリが受け取り、Ctrl+[ で抜けた後のキーは受け取らない(Ctrl+] から変えた。ADR 0030)
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
  await page.keyboard.press('Control+BracketLeft');
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

// 4.2: タイトルバーのボタンでも入力モードに入れて、抜けられる。入力モードの表示は映像に重ねず、下のバーに出す
test('タイトルバーのボタンで入力モードを切り替え、表示は下のバーに出る', async ({ page, dew }) => {
  const keylog = join(mkdtempSync(join(tmpdir(), 'dew-keys-')), 'keys.txt');
  writeFileSync(keylog, '');
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0'], { DEW_TEST_KEYLOG: keylog });
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.waitForTimeout(1000);
  await win.getByRole('button', { name: '入力モード(i)' }).click();
  await expect(win).toHaveAttribute('data-input', 'true');
  await expect(win.locator('.live-bar .input-hint')).toBeVisible();
  await expect(win.locator('.window-body .input-hint')).toHaveCount(0);
  await page.keyboard.type('ab');
  await expect.poll(() => readFileSync(keylog, 'utf8').split('\n').filter(Boolean)).toEqual(['a', 'b']);
  await win.getByRole('button', { name: '入力モードを抜ける(Ctrl+[)' }).click();
  await expect(win).toHaveAttribute('data-input', 'false');
  await expect(win.locator('.input-hint')).toHaveCount(0);
});

// 7.6: ライブウィンドウにも個別のミュートがある(右下のボタンと m)
test('ライブウィンドウを個別にミュートできる', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '440']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.getByTestId('global-mute').click();
  const peak = () => page.evaluate(() => (window as unknown as { dewTest: { audioPeakHz(): number | null } }).dewTest.audioPeakHz());
  await expect.poll(peak, { timeout: 15_000 }).toBeGreaterThan(430);
  const mute = win.locator('.live-bar').getByRole('button', { name: 'ミュート' });
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(peak, { timeout: 15_000 }).toBeNull();
  await page.keyboard.press('m');
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(peak, { timeout: 15_000 }).toBeGreaterThan(430);
  // 音量のバーを 0 にすると鳴らず、戻すと鳴る
  const volume = win.locator('.live-bar').getByRole('slider', { name: '音量' });
  await volume.fill('0');
  await expect.poll(peak, { timeout: 15_000 }).toBeNull();
  await volume.fill('1');
  await expect.poll(peak, { timeout: 15_000 }).toBeGreaterThan(430);
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

// 7.9: メニューやツールチップのような一時的な窓(override-redirect)が、親の映像に重なって映る
// (親の範囲からはみ出した部分は映らない。ADR 0012)
test('一時的な窓が親の映像に重なって映る', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('popup.py'), '--outside']);
  const win = liveWindow(page, 'popup');
  await expect(win).toBeVisible(APPEAR);
  // 一時的な窓は、キャンバスに別のウィンドウとしては出ない
  await expect(page.getByTestId('live-window')).toHaveCount(1);
  const rgb = (x: number, y: number) =>
    win.locator('canvas').evaluate((c: HTMLCanvasElement, [x, y]) => [...c.getContext('2d')!.getImageData(x, y, 1, 1).data.slice(0, 3)], [x, y] as const);
  const near = (want: number[]) => (got: number[]) => got.every((v, i) => Math.abs(v - want[i]!) < 48);
  // 親の灰色、内側の赤い窓、右下にはみ出した緑の窓のうち親に重なる部分
  await expect.poll(() => rgb(10, 10).then(near([128, 128, 128])), APPEAR).toBe(true);
  await expect.poll(() => rgb(100, 80).then(near([255, 0, 0])), APPEAR).toBe(true);
  await expect.poll(() => rgb(360, 290).then(near([0, 255, 0])), APPEAR).toBe(true);
});
