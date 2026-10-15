// フェーズ1の受け入れ基準(docs/spec.md 11章): キャンバスのプレイヤー
import { expect, frameNumber, open, start, test } from '../lib/dew';

// 基準4: H.264 の MP4 が変換なしで再生され、音声トラックが有効になっている
test.fixme('H.264 の MP4 を変換なしで音声付き再生する', async ({ page, dew }) => {
  const transcodes: string[] = [];
  page.on('request', (r) => r.url().includes('transcode=1') && transcodes.push(r.url()));
  await start(page, dew);
  const video = await open(page, 'h264_aac.mp4');

  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement & { webkitAudioDecodedByteCount: number }) => v.webkitAudioDecodedByteCount))
    .toBeGreaterThan(0);
  expect(transcodes).toEqual([]);
});

// 基準5: `mp4v` の MP4 と AVI が変換されて再生される(キャッシュはサーバのテストで確かめる)
for (const name of ['mp4v.mp4', 'xvid_mp3.avi']) {
  test.fixme(`${name} を変換して再生する`, async ({ page, dew }) => {
    await start(page, dew);
    const video = await open(page, name);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
    // Media Source Extensions で再生している
    expect(await video.evaluate((v: HTMLVideoElement) => v.src)).toMatch(/^blob:/);
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement & { webkitAudioDecodedByteCount: number }) => v.webkitAudioDecodedByteCount))
      .toBeGreaterThan(0);
  });
}

// 基準6: `.` を押すと表示中の番号がちょうど1増える。`0`–`9` で 0–90% の位置に移動する
test.fixme('コマ送りと 0–9 の移動', async ({ page, dew }) => {
  await start(page, dew);
  const video = await open(page, 'h264_aac.mp4');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
  await page.keyboard.press('k');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  for (let i = 0; i < 5; i++) {
    const before = await frameNumber(page, video);
    await page.keyboard.press('.');
    await expect.poll(() => frameNumber(page, video)).toBe(before + 1);
  }
  const before = await frameNumber(page, video);
  await page.keyboard.press(',');
  await expect.poll(() => frameNumber(page, video)).toBe(before - 1);

  // 素材は 10 秒・300 フレーム
  for (const key of ['5', '9', '0', '3']) {
    await page.keyboard.press(key);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(Number(key), 1);
    await expect.poll(() => frameNumber(page, video)).toBe(Number(key) * 30);
  }
});
