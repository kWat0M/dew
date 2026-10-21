// フェーズ5の受け入れ基準(docs/spec.md 11章)のうち、ブラウザで確かめるもの。
// シェル連携と、端末に書き込むシーケンスは Rust のテスト(crates/dew/tests/phase5.rs)
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

// 基準7: サーバを再起動しても、開いていたタブが(読み直さずに)自動で再接続する
test('サーバを再起動すると、開いていたタブが自動で再接続する', async ({ page, dew }) => {
  await start(page, dew);
  // 読み直していないことを確かめる印
  await page.evaluate(() => ((window as unknown as { dewMark: number }).dewMark = 1));
  dew.stop();
  await expect(page.getByTestId('server-offline')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('server-offline')).toContainText('サーバ停止中');
  dew.restart();
  await expect(page.getByTestId('server-offline')).toBeHidden({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { dewMark?: number }).dewMark)).toBe(1);
  // つなぎ直したタブに表示指示が届く(トークンと Cookie がそのまま使える)
  dew.run([join(dew.root, 'image.png')]);
  await expect(page.getByTestId('player-window').filter({ hasText: 'image.png' })).toBeVisible();
});

// 基準9: タブがない状態で `dew a.mp4` を実行し、2分以内に Home の URL を開くと a.mp4 が開く
test('タブがないときの dew <ファイル> は、あとで開いたタブに届く', async ({ page, dew }) => {
  dew.run([join(dew.root, 'h264_aac.mp4')]);
  await start(page, dew);
  await expect(page.getByTestId('player-window').filter({ hasText: 'h264_aac.mp4' })).toBeVisible();
});

// 基準10: 裏にあるタブに表示指示が届くと、タイトルの先頭に ● が付き、表に出すと消える。
// ヘッドレスのブラウザは、ほかのタブを前に出してもタブを裏にしないので、ページの見え方を差し替えて知らせる
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('裏のタブに表示指示が届くとタイトルに ● が付く', async ({ page, dew }) => {
  await start(page, dew);
  await expect(page).toHaveTitle('dew');
  await setHidden(page, true);
  dew.run([join(dew.root, 'h264_aac.mp4')]);
  await expect(page).toHaveTitle('● dew');
  await setHidden(page, false);
  await expect(page).toHaveTitle('dew');
  await expect(page.getByTestId('player-window').filter({ hasText: 'h264_aac.mp4' })).toBeVisible();
  // 表にあるときに届いても付けない
  dew.run([join(dew.root, 'image.png')]);
  await expect(page.getByTestId('player-window').filter({ hasText: 'image.png' })).toBeVisible();
  await expect(page).toHaveTitle('dew');
});
