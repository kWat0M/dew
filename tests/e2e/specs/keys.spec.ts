// キー操作の見直し(2026-10-24、ADR 0030)の受け入れ基準: 抜けるキー(Esc・Ctrl+[・q)、CSV の小さな画面のキー操作、
// Home のプレビューのクリック、キャンバスのノーマルモード / 操作モード / 入力モード、マウスでの操作モード
import { csvWindow, openCsv, status } from '../lib/csv';
import { copyCsv, current, expect, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

// 文字を打つ欄は Esc・Ctrl+[ で欄から抜けるだけ。欄は残り、もう一度押すと閉じる
test('Home の絞り込みは Esc で欄から抜け、もう一度 Esc で解除する', async ({ page, dew }) => {
  await start(page, dew);
  await expect(current(page).getByRole('option').first()).toBeVisible();
  const all = await current(page).getByRole('option').count();
  await page.keyboard.press('/');
  const box = page.locator('input.filter');
  await expect(box).toBeFocused();
  await page.keyboard.type('image');
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();
  await expect(current(page).getByRole('option')).toHaveCount(2);
  // 欄の外ではキーマップが効く
  await page.keyboard.press('G');
  await expect(current(page).getByRole('option', { selected: true })).toHaveAttribute('data-name', 'image.png');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(current(page).getByRole('option')).toHaveCount(all);
  // Ctrl+[ も Esc と同じ
  await page.keyboard.press('/');
  await page.keyboard.type('jpg');
  await page.keyboard.press('Control+BracketLeft');
  await expect(box).not.toBeFocused();
  await expect(current(page).getByRole('option')).toHaveCount(1);
});

test('CSV の検索欄は Esc・Ctrl+[ で欄から抜け、もう一度押すと閉じる', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await page.keyboard.press('/');
  const box = win.getByRole('textbox', { name: '検索' });
  await expect(box).toBeFocused();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Control+BracketLeft');
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();
  // 欄の外では表のキーが効く
  await page.keyboard.press('j');
  await expect(status(win)).toContainText('A2');
  // / で欄に戻る
  await page.keyboard.press('/');
  await expect(box).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(csvWindow(page, 'rows10k.csv')).toHaveAttribute('data-input', 'true');
});
