import { expect, test } from '@playwright/test';

test('Chrome で H.264 / AAC の fragmented MP4 を扱える', async ({ page }) => {
  const supported = await page.evaluate(() =>
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
  );
  expect(supported).toBe(true);
});
