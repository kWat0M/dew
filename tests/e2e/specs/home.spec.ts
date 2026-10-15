// フェーズ1の受け入れ基準(docs/spec.md 11章): Home
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { current, expect, open, selected, start, test } from '../lib/dew';

// 基準3: Home で j/k/h/l/Enter が動き、3カラムとサムネイルが表示される
test('Home のキー操作と3カラム・サムネイル', async ({ page, dew }) => {
  await start(page, dew);
  for (const col of ['col-parent', 'col-current', 'col-preview']) {
    await expect(page.getByTestId(col)).toBeVisible();
  }
  // ディレクトリが先、名前順。隠しファイルは出さない
  await expect(current(page).getByRole('option')).toHaveText([
    'sub', 'broken.mp4', 'h264_aac.mp4', 'image.jpg', 'image.png', 'mp4v.mp4', 'xvid_mp3.avi',
  ]);
  expect(await selected(page)).toBe('sub');

  await page.keyboard.press('j');
  expect(await selected(page)).toBe('broken.mp4');
  await page.keyboard.press('k');
  expect(await selected(page)).toBe('sub');

  // l でディレクトリの中へ。左カラムは親(元の場所)になる
  await page.keyboard.press('l');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  await expect(page.getByTestId('col-parent').getByRole('option', { selected: true })).toHaveText('sub');
  // h で戻ると、出てきたディレクトリが選ばれている
  await page.keyboard.press('h');
  expect(await selected(page)).toBe('sub');

  // 画像を選ぶと、右カラムにサムネイルが出る
  for (let i = 0; i < 4; i++) await page.keyboard.press('j');
  expect(await selected(page)).toBe('image.png');
  const thumb = page.getByTestId('col-preview').locator('img');
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // 動画もサムネイルが出る(中央カラム)
  const videoThumb = current(page).getByRole('option', { name: 'h264_aac.mp4' }).locator('img');
  await expect.poll(() => videoThumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // Enter でキャンバスにウィンドウが追加される
  await open(page, 'h264_aac.mp4');
});

// 基準7: 新しいファイルを出力ディレクトリに置くと、1秒以内に Home に現れる
test('新しいファイルが1秒以内に現れる', async ({ page, dew }) => {
  await start(page, dew);
  await expect(current(page).getByRole('option', { name: 'image.png' })).toBeVisible();
  copyFileSync(join(dew.root, 'image.png'), join(dew.root, 'new.png'));
  await expect(current(page).getByRole('option', { name: 'new.png' })).toBeVisible({ timeout: 1000 });
});
