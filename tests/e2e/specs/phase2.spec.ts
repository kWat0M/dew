// フェーズ2の受け入れ基準(docs/spec.md 11章): 比較・画像
import { join } from 'node:path';
import { type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { copyP2, expect, open, pick, pixelOf, start, test } from '../lib/dew';

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
  // 2枚目の読み込み前は全体が黒いので、違うところが明るくなるまで待つ(負荷が高いと間に合わないことがあった)
  await expect.poll(async () => isBlack(await colorAt(page, media, 0.6875, 0.639))).toBe(false);
});

// 基準3: 画像の等倍表示で、指定したピクセルの値が元画像と一致する
test('等倍表示でピクセルの値が元画像と一致する', async ({ page, dew }) => {
  await start(page, dew);
  await open(page, 'image.png');
  await page.keyboard.press('z');
  const img = page.getByTestId('player-window').locator('img');
  // 読み込み中の表示が消えてからマウスを動かす(ブラウザは表示が消えただけではマウスのイベントを出さない)
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(640);
  await expect(page.locator('.window-overlay')).toBeHidden();
  const box = (await img.boundingBox())!;
  expect(Math.round(box.width)).toBe(640);
  for (const [x, y] of [[100, 50], [5, 300], [639, 359]] as const) {
    await page.mouse.move(box.x + x + 0.5, box.y + y + 0.5);
    const [r, g, b] = pixelOf(join(dew.root, 'image.png'), x, y);
    await expect(page.getByTestId('pixel-info')).toHaveText(`x ${x}, y ${y}  R ${r} G ${g} B ${b} A 255`);
  }
});

// F8 / 2.6: 16bit PNG と TIFF も表示でき、16bit は元の値を出す
test('16bit PNG と TIFF を表示し、16bit は元の値を出す', async ({ page, dew }) => {
  copyP2(dew, ['image16.png', 'image.tif']);
  await start(page, dew);
  await open(page, 'image.tif');
  await expect.poll(() => page.getByTestId('player-window').locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  await page.keyboard.press('h');
  await open(page, 'image16.png');
  const win = page.getByTestId('player-window').filter({ hasText: 'image16.png' });
  await page.keyboard.press('z');
  const img = win.locator('img');
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(640);
  await expect(win.locator('.window-overlay')).toBeHidden();
  const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + 100.5, box.y + 50.5);
  const [r, g, b] = pixelOf(join(dew.root, 'image16.png'), 100, 50, 16);
  await expect(win.getByTestId('pixel-info')).toHaveText(`x 100, y 50  R ${r} G ${g} B ${b} A 65535`);
});

test('比較ウィンドウの再生コントロールは1ファイルのウィンドウと同じ', async ({ page, dew }) => {
  await start(page, dew);
  await pick(page, ['h264_aac.mp4', 'mp4v.mp4']);
  await page.keyboard.press('c');
  const win = page.getByTestId('compare-window');
  for (const name of ['5秒戻り', '30秒戻り', '30秒送り', '5秒送り', '再生速度', '全画面']) {
    await expect(win.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(win.getByRole('slider', { name: '音量' })).toBeVisible();
  const master = win.locator('video').first();
  await win.getByRole('button', { name: '再生速度' }).click();
  await page.getByRole('menu', { name: '再生速度' }).getByRole('menuitemradio', { name: '2x' }).click();
  await expect.poll(() => win.locator('video').evaluateAll((vs: HTMLVideoElement[]) => vs.map((v) => v.playbackRate))).toEqual([2, 2]);
  expect(await master.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
});

test('比較ウィンドウも全体のミュートに従い、解除すると1つ目だけ音を出す', async ({ page, dew }) => {
  await start(page, dew);
  await pick(page, ['h264_aac.mp4', 'mp4v.mp4']);
  await page.keyboard.press('c');
  const win = page.getByTestId('compare-window');
  const first = win.locator('video').first();
  await expect.poll(() => first.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
  await expect(page.getByTestId('global-mute')).toContainText('ミュートを解除');
  expect(await win.locator('video').evaluateAll((vs: HTMLVideoElement[]) => vs.map((v) => v.muted))).toEqual([true, true]);
  await page.getByTestId('global-mute').click();
  // 音を出すのは1つ目だけ(2つ目は重ならないようミュートのまま)
  await expect.poll(() => win.locator('video').evaluateAll((vs: HTMLVideoElement[]) => vs.map((v) => v.muted))).toEqual([false, true]);
});
