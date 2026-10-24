// フェーズ8(テーマ・スマホの画面・ダウンロード。spec 18 章)の受け入れ基準
import type { Page } from '@playwright/test';
import { expect, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

const LIGHT_SURFACE = '#faf8ff';
const DARK_SURFACE = '#121318';
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function chooseTheme(page: Page, label: string) {
  await page.getByRole('button', { name: '操作パネル' }).click();
  await page.getByTestId('theme').getByText(label, { exact: true }).click();
  await page.getByRole('button', { name: '操作パネル' }).click();
}

// 18.1: ライト・ダークに固定でき、読み直しても最初の描画から選んだ色で出る
test('テーマをライト・ダーク・ブラウザに合わせるで切り替えられる', async ({ page, dew }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await start(page, dew);
  expect(await token(page, '--md-sys-color-surface')).toBe(LIGHT_SURFACE);

  await chooseTheme(page, 'ダーク');
  await expect.poll(() => token(page, '--md-sys-color-surface')).toBe(DARK_SURFACE);
  expect(await token(page, '--dew-frame-focus')).toBe('#7aa2f7');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');

  // 読み直しても、画面のスクリプトを読む前からダーク(index.html のスクリプトが付ける)
  await page.route('**/assets/*.js', (r) => r.abort());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await token(page, '--md-sys-color-surface')).toBe(DARK_SURFACE);
  await page.unroute('**/assets/*.js');

  // ブラウザに合わせると、ブラウザの設定で変わる
  await start(page, dew);
  await chooseTheme(page, 'ブラウザに合わせる');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await token(page, '--md-sys-color-surface')).toBe(LIGHT_SURFACE);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await token(page, '--md-sys-color-surface')).toBe(DARK_SURFACE);

  // ブラウザがダークでも、ライトに固定できる
  await chooseTheme(page, 'ライト');
  await expect.poll(() => token(page, '--md-sys-color-surface')).toBe(LIGHT_SURFACE);
  expect(await token(page, '--dew-frame-focus')).toBe('#2e7de9');
});
