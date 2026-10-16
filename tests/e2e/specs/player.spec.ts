// フェーズ1の受け入れ基準(docs/spec.md 11章): キャンバスのプレイヤー
import { audioDecoded, expect, frameNumber, open, start, test } from '../lib/dew';

// 基準4: H.264 の MP4 が変換なしで再生され、音声トラックが有効になっている
test('H.264 の MP4 を変換なしで音声付き再生する', async ({ page, dew }) => {
  const transcodes: string[] = [];
  page.on('request', (r) => r.url().includes('transcode=1') && transcodes.push(r.url()));
  await start(page, dew);
  const video = await open(page, 'h264_aac.mp4');

  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await expect.poll(() => audioDecoded(video)).toBe(true);
  expect(transcodes).toEqual([]);
});

// 基準5: `mp4v` の MP4 と AVI が変換されて再生される(キャッシュはサーバのテストで確かめる)
for (const name of ['mp4v.mp4', 'xvid_mp3.avi']) {
  test(`${name} を変換して再生する`, async ({ page, dew }) => {
    await start(page, dew);
    const video = await open(page, name);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
    // Media Source Extensions で再生している
    expect(await video.evaluate((v: HTMLVideoElement) => v.src)).toMatch(/^blob:/);
    await expect.poll(() => audioDecoded(video)).toBe(true);
  });
}

// 基準6: `.` を押すと表示中の番号がちょうど1増える。`0`–`9` で 0–90% の位置に移動する
test('コマ送りと 0–9 の移動', async ({ page, dew }) => {
  await start(page, dew);
  const video = await open(page, 'h264_aac.mp4');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
  await page.keyboard.press('k');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  // 一時停止の直後、Firefox の drawImage は表示中の1つ前のフレームを返すことがあるので、
  // 起点は画面の番号表示から取る。コマ送りの後(シーク後)は画素も正しく読める
  const label = page.getByTestId('frame-number');
  const shown = async () => Number((await label.textContent())?.match(/\d+/)?.[0]);

  for (let i = 0; i < 5; i++) {
    const before = await shown();
    await page.keyboard.press('.');
    await expect.poll(() => frameNumber(page, video)).toBe(before + 1);
    await expect.poll(shown).toBe(before + 1);
  }
  const before = await shown();
  await page.keyboard.press(',');
  await expect.poll(() => frameNumber(page, video)).toBe(before - 1);

  // 素材は 10 秒・300 フレーム
  for (const key of ['5', '9', '0', '3']) {
    await page.keyboard.press(key);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(Number(key), 1);
    await expect.poll(() => frameNumber(page, video)).toBe(Number(key) * 30);
  }
});

// 変換した動画でも、セグメントの境目をまたいでフレーム番号がずれない(7.4、7.5)
test('変換した動画の 2 番目のセグメントでもフレーム番号が合う', async ({ page, dew }) => {
  await start(page, dew);
  const video = await open(page, 'mp4v.mp4');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
  await page.keyboard.press('k');
  for (const key of ['7', '2', '9']) {
    await page.keyboard.press(key);
    await expect.poll(() => frameNumber(page, video)).toBe(Number(key) * 30);
  }
  // 6 秒の境目の前後
  await page.keyboard.press('2');
  await expect.poll(() => frameNumber(page, video)).toBe(60);
  for (let i = 0; i < 4; i++) await page.keyboard.press('L'); // 30 秒進む → 末尾
  await page.keyboard.press('6');
  await expect.poll(() => frameNumber(page, video)).toBe(180);
  await page.keyboard.press(',');
  await expect.poll(() => frameNumber(page, video)).toBe(179);
  await page.keyboard.press('.');
  await expect.poll(() => frameNumber(page, video)).toBe(180);
});

// F10: dew <ファイル> で、接続中のタブのキャンバスにウィンドウが追加される
test('dew <ファイル> で開いているタブに表示する', async ({ page, dew }) => {
  await start(page, dew);
  await expect(page.getByTestId('col-current').getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(1200); // 操作したタブとして登録されるのを待つ
  const out = dew.run([`${dew.root}/h264_aac.mp4`]);
  expect(out).toContain('ブラウザに表示しました');
  const win = page.getByTestId('player-window').filter({ hasText: 'h264_aac.mp4' });
  await expect(win).toBeVisible();
  await expect.poll(() => win.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
});
