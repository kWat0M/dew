// キー操作の見直し(2026-10-24、ADR 0030)の受け入れ基準: 抜けるキー(Esc・Ctrl+[・q)、CSV の小さな画面のキー操作、
// Home のプレビューのクリック、キャンバスのノーマルモード / 操作モード / 入力モード、マウスでの操作モード
import { csvWindow, goCol, openCsv, status } from '../lib/csv';
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

// CSV の小さな画面は、欄を hjkl・矢印で選び、Enter で入る(選択欄は一覧を開き、j / k で選んで Enter)
test('フィルターの画面を hjkl と Enter だけで操作する', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await goCol(page, win, 2);
  await page.keyboard.press('f');
  const dialog = page.getByRole('dialog', { name: /フィルター/ });
  // 開いた直後は値の欄に入っていて、すぐ打てる
  const value = dialog.getByLabel('値');
  await expect(value).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(value).not.toBeFocused();
  await expect(dialog).toBeVisible();
  // k で条件の欄へ、Enter で一覧を開いて j で「>」へ
  await page.keyboard.press('k');
  const op = dialog.getByRole('combobox', { name: '条件' });
  await expect(op).toBeFocused();
  await page.keyboard.press('Enter');
  const list = page.getByRole('listbox', { name: '条件' });
  await expect(list).toBeVisible();
  for (let i = 0; i < 4; i++) await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(op).toHaveText('>');
  // j で値の欄へ、Enter で入って打ち、Enter で適用
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(value).toBeFocused();
  await page.keyboard.type('0');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(win.getByTestId('csv-rows')).not.toHaveText(/^10,000 \/ 10,000 行/);
});

test('強調の画面を矢印と Enter だけで操作し、Esc で1段ずつ閉じる', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await goCol(page, win, 1);
  await page.keyboard.press('M');
  const dialog = page.getByRole('dialog', { name: '条件付き強調' });
  const add = dialog.getByRole('button', { name: 'ルールを足す' });
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('combobox', { name: '強調 1' })).toBeVisible();
  // 上の行(ルール)へ移り、左へ動いて値の欄に入る
  await page.keyboard.press('ArrowUp');
  const value = dialog.getByRole('textbox', { name: '値' });
  for (let i = 0; i < 4 && !(await value.evaluate((el) => el.parentElement === document.activeElement)); i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(value).toBeFocused();
  await page.keyboard.type('alpha');
  await expect(win.locator('.csv-tr[class*="rule-"]').first()).toBeVisible();
  // Esc で欄から抜け、もう一度 Esc で画面を閉じる。CSV の操作モードは続く
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(csvWindow(page, 'rows10k.csv')).toHaveAttribute('data-input', 'true');
});
