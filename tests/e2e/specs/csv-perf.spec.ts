// フェーズ7の基準5: 100万行(約 100 MB)の CSV が大規模モードで開き、読み込み中は進捗が表示される。
// 読み込み後のソート・フィルターの結果が1秒以内に表示される(開発用コンテナで測定)。
// 時間を測るので、playwright.config.ts の timing-* プロジェクトで、ほかのテストの後に流す(ADR 0011)
import { join } from 'node:path';
import { csvWindow, goCol, header, rowNumbers, status } from '../lib/csv';
import { copyCsv, expect, reloadPage, start, test } from '../lib/dew';

test.describe.configure({ timeout: 120_000 });

test('100万行は大規模モードで開き、進捗を出し、ソート・フィルターが1秒以内', async ({ page, dew }) => {
  copyCsv(dew, ['rows1m.csv']);
  await start(page, dew);
  // 進捗の表示は短いので、出た瞬間を記録しておく
  await page.evaluate(() => {
    const w = window as unknown as { csvProgressSeen: boolean };
    w.csvProgressSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="csv-progress"]')) w.csvProgressSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const opened = Date.now();
  dew.run([join(dew.root, 'csv', 'rows1m.csv')]);
  const win = csvWindow(page, 'rows1m.csv');
  await expect(win.getByRole('gridcell').first()).toBeVisible({ timeout: 60_000 });
  const loaded = Date.now() - opened;
  expect(await page.evaluate(() => (window as unknown as { csvProgressSeen: boolean }).csvProgressSeen)).toBe(true);
  await expect(status(win)).toContainText('大規模');
  await expect(win.getByTestId('csv-rows')).toHaveText('1,000,000 / 1,000,000 行');

  /** 操作してから、表示が変わるまでの時間(ミリ秒) */
  const timed = async (act: () => Promise<void>, done: () => Promise<void>) => {
    const t = Date.now();
    await act();
    await done();
    return Date.now() - t;
  };
  await goCol(page, win, 2);
  const first = (await rowNumbers(win))[0];
  const sort = await timed(
    () => page.keyboard.press('s'),
    async () => {
      await expect(header(win, 2)).toHaveAttribute('aria-sort', 'ascending');
      // 新しい結果が届くまでは前の結果が出ているので、先頭の行が変わるのを待つ
      await expect.poll(async () => (await rowNumbers(win))[0], { intervals: [20] }).not.toBe(first);
    },
  );
  expect(sort).toBeLessThan(1000);
  const before = await win.getByTestId('csv-rows').textContent();
  // フィルターは、値を入れて Enter を押してから表示が変わるまで
  await page.keyboard.press('f');
  const dialog = page.getByRole('dialog', { name: /フィルター/ });
  await dialog.getByLabel('条件').selectOption('gt');
  await dialog.getByLabel('値').fill('500');
  const filtered = await timed(
    () => dialog.getByLabel('値').press('Enter'),
    () => expect.poll(() => win.getByTestId('csv-rows').textContent(), { intervals: [20] }).not.toBe(before),
  );
  expect(filtered).toBeLessThan(1000);
  // サーバを起動し直しても、作ったデータベース(~/.cache/dew/csv)を使い、読み込み直さない
  dew.stop();
  dew.restart();
  await reloadPage(page);
  const again = Date.now();
  dew.run([join(dew.root, 'csv', 'rows1m.csv')]);
  await expect(csvWindow(page, 'rows1m.csv').getByRole('gridcell').first()).toBeVisible({ timeout: 60_000 });
  const reopened = Date.now() - again;
  expect(reopened).toBeLessThan(3000);
  // 測った値を残す(人が見て、余裕がどれだけあるかを知るため)
  console.log(`CSV 100万行: 読み込み ${loaded} ms、ソート ${sort} ms、フィルター ${filtered} ms、起動し直して開く ${reopened} ms`);
});
