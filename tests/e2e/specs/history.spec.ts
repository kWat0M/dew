// 画面の移り変わりとブラウザの履歴(docs/spec.md 4.5)。戻る・進むで前の画面・ディレクトリ・文書へ。
// マウスのサイドボタンはブラウザの戻る・進むそのものなので、page.goBack / goForward で確かめる
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { copyMd, current, expect, open, selected, start, test, type Dew } from '../lib/dew';

const homeUrl = (dir: string) => new RegExp(`/home${dir.split('/').map(encodeURIComponent).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Home が出ているか */
const onHome = (page: Page) => expect(current(page)).toBeVisible();
const onCanvas = (page: Page) => expect(current(page)).toBeHidden();

test('Home のディレクトリ移動を戻る・進むで辿り、カーソルも元の位置に戻る', async ({ page, dew }) => {
  await start(page, dew);
  await expect.poll(() => selected(page)).toBe('sub');
  await page.keyboard.press('l');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  await expect(page).toHaveURL(homeUrl(join(dew.root, 'sub')));
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(current(page).getByRole('option', { name: 'image.png' })).toBeVisible();
  await expect.poll(() => selected(page)).toBe('sub');
  await page.goForward();
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  // h で親へ移るのも履歴に積む
  await page.keyboard.press('h');
  await expect(current(page).getByRole('option', { name: 'image.png' })).toBeVisible();
  await page.goBack();
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
});

test('パンくずはリンクで、押すと履歴に積む', async ({ page, dew }) => {
  await start(page, dew);
  await page.keyboard.press('l');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  const crumb = page.getByRole('navigation', { name: 'path' }).getByRole('link', { name: dew.root.split('/').pop()!, exact: true });
  await expect(crumb).toHaveAttribute('href', homeUrl(dew.root));
  await crumb.click();
  await expect(current(page).getByRole('option', { name: 'image.png' })).toBeVisible();
  await page.goBack();
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
});

test('再読み込みしても同じディレクトリを開く', async ({ page, dew }) => {
  await start(page, dew);
  await page.keyboard.press('l');
  await expect(page).toHaveURL(homeUrl(join(dew.root, 'sub')));
  await page.reload();
  const overlay = page.getByTestId('start-overlay');
  await expect(async () => {
    await page.keyboard.press('Shift');
    await expect(overlay).toBeHidden({ timeout: 500 });
  }).toPass();
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
});

test('Home とキャンバスの行き来を戻る・進むで辿る', async ({ page, dew }) => {
  await start(page, dew);
  await open(page, 'h264_aac.mp4');
  await expect(page).toHaveURL(/\/canvas$/);
  await onCanvas(page);
  await page.goBack();
  await onHome(page);
  await page.goForward();
  await onCanvas(page);
  await expect(page.getByTestId('player-window')).toBeVisible();
  // Tab で Home へ移るのも履歴に積む
  await page.keyboard.press('Tab');
  await onHome(page);
  await page.goBack();
  await onCanvas(page);
});

/** `dew <ファイル>` で文書を開き、描画を待つ */
async function openDoc(page: Page, dew: Dew, rel: string) {
  dew.run([join(dew.root, 'md', rel)]);
  const win = page.getByTestId('document-window');
  await expect(win.getByTestId('doc-body')).toBeVisible();
  return win;
}

test('文書のリンクで移った先から、ブラウザの戻る・進むで前の文書へ', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'docs/b.md');
  const h1 = win.getByTestId('doc-body').locator('h1');
  await win.getByRole('link', { name: 'A へ戻る' }).click();
  await expect(h1).toHaveText('A の文書');
  await page.goBack();
  await expect(h1).toHaveText('B の文書');
  await page.goForward();
  await expect(h1).toHaveText('A の文書');
  // 文書を開く前の Home まで戻れる
  await page.goBack();
  await page.goBack();
  await onHome(page);
  await page.goForward();
  await onCanvas(page);
  await expect(h1).toHaveText('B の文書');
});

test('文書の戻る・進むのボタンはブラウザの戻る・進むと同じで、ウィンドウの中央にある', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'docs/b.md');
  const h1 = win.getByTestId('doc-body').locator('h1');
  const back = win.getByRole('button', { name: /^戻る/ });
  const forward = win.getByRole('button', { name: /^進む/ });
  await expect(forward).toBeDisabled();
  await win.getByRole('link', { name: 'A へ戻る' }).click();
  await expect(h1).toHaveText('A の文書');
  await back.click();
  await expect(h1).toHaveText('B の文書');
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(h1).toHaveText('A の文書');
  await expect(forward).toBeDisabled();
  // ブラウザで戻ったのと同じ
  await page.goBack();
  await expect(h1).toHaveText('B の文書');
  // 文書を開く前の Home へも戻る
  await back.click();
  await onHome(page);
  // 2つのボタンの中ほどが、ウィンドウの横幅の中央にある
  await page.goForward();
  const box = (await win.boundingBox())!;
  const b = (await back.boundingBox())!;
  const f = (await forward.boundingBox())!;
  expect(Math.abs((b.x + f.x + f.width) / 2 - (box.x + box.width / 2))).toBeLessThan(8);
  expect(b.width).toBeGreaterThanOrEqual(36);
});
