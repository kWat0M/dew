// CSV のウィンドウ(フェーズ7)を操作するテスト部品
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, type Dew } from './dew';

/** CSV のウィンドウ。名前はファイル名 */
export function csvWindow(page: Page, name: string) {
  return page.getByTestId('csv-window').and(page.getByLabel(name, { exact: true }));
}

/** `dew <ファイル>` で開き、表が出るのを待つ */
export async function openCsv(page: Page, dew: Dew, name: string) {
  dew.run([join(dew.root, 'csv', name)]);
  const win = csvWindow(page, name);
  await expect(win.getByRole('gridcell').first()).toBeVisible({ timeout: 20_000 });
  return win;
}

export const status = (win: Locator) => win.getByTestId('csv-status');
/** 元の行番号(1 から)と列番号(0 から)のセル */
export const cell = (win: Locator, row: number, col: number) => win.locator(`[role="row"][data-row="${row}"] [role="gridcell"][data-col="${col}"]`);
export const header = (win: Locator, col: number) => win.locator(`[role="columnheader"][data-col="${col}"]`);
/** 表示中の行の、元の行番号(上から) */
export async function rowNumbers(win: Locator) {
  return (await win.locator('[role="row"][data-row]').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-row'))))).filter((n) => n > 0);
}

/** 選択欄で選ぶ(マウスで開き、値が value の項目を押す) */
export async function choose(page: Page, scope: Locator, label: string, value: string) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('listbox', { name: label }).locator(`[role="option"][data-value="${value}"]`).click();
}

/** 選択中の列にフィルターを付ける(f で開き、条件を選び、値を打って Enter。値がなければ適用のボタン) */
export async function filter(page: Page, op: string, value?: string) {
  await page.keyboard.press('f');
  const dialog = page.getByRole('dialog', { name: /フィルター/ });
  await expect(dialog).toBeVisible();
  await choose(page, dialog, '条件', op);
  if (value !== undefined) {
    const input = dialog.getByLabel('値');
    await input.fill(value);
    await input.press('Enter');
  } else await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog).toBeHidden();
}

/** 選択中の列番号(0 から) */
export async function selectedCol(win: Locator) {
  return Number(await win.locator('[role="gridcell"][aria-selected="true"]').getAttribute('data-col'));
}

/** 選択中の列を col に合わせる(h / l で動かす) */
export async function goCol(page: Page, win: Locator, col: number) {
  for (let now = await selectedCol(win); now !== col; now = await selectedCol(win)) await page.keyboard.press(now < col ? 'l' : 'h');
}
