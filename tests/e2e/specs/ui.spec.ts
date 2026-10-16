// 操作画面の改訂(2026-10-16): マウスだけで全操作(操作パネル)、ヒント、キー一覧、停止、タブバーの形
import { type Page } from '@playwright/test';
import { current, expect, open, selected, start, test } from '../lib/dew';

const panel = (page: Page) => page.getByTestId('ops-panel');
const openPanel = (page: Page) => page.getByRole('button', { name: '操作パネル' }).click();

test('操作パネルのボタンだけで Home とキャンバスを操作できる', async ({ page, dew }) => {
  await start(page, dew);
  await openPanel(page);
  await expect(panel(page)).toBeVisible();
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^下へ/ }).click();
  expect(await selected(page)).toBe('broken.mp4');
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^下へ/ }).click();
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^開く/ }).click();
  const video = page.getByTestId('player-window').locator('video');
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.2);

  // キャンバスでは再生とウィンドウ操作が並ぶ
  await panel(page).getByRole('button', { name: /^再生 \/ 一時停止/ }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^Home へ戻る/ }).click();
  await expect(current(page)).toBeVisible();
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^キャンバスへ/ }).click();
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^全部閉じる/ }).click();
  await expect(page.getByTestId('player-window')).toHaveCount(0);
  await panel(page).getByTestId('ops-all').getByRole('button', { name: /^履歴/ }).click();
  await expect(page.getByTestId('history')).toBeVisible();
  await page.getByTestId('history').getByRole('button', { name: '閉じる' }).click();

  await panel(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(panel(page)).toBeHidden();
});

test('ヒントの帯は閉じられ、ブラウザが覚える。キー一覧はボタンでも開ける', async ({ page, dew }) => {
  await start(page, dew);
  // Home とキャンバスの両方が残っているので、見えている方を指す
  const hints = page.getByTestId('hint-bar').filter({ visible: true });
  await expect(hints).toContainText('j/k');
  await hints.getByRole('button', { name: '閉じる' }).click();
  await expect(hints).toBeHidden();
  await page.reload();
  await page.keyboard.press('Shift');
  await expect(current(page).getByRole('option').first()).toBeVisible();
  await expect(hints).toBeHidden();

  await page.getByRole('button', { name: 'キー一覧' }).click();
  const help = page.getByRole('dialog', { name: 'キー一覧' });
  await expect(help).toContainText('ウィンドウ操作モード');
  await help.getByRole('button', { name: '閉じる' }).click();
  await expect(help).toBeHidden();
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
});

test('停止ボタンで確認のうえサーバが止まる', async ({ page, dew }) => {
  await start(page, dew);
  await page.getByRole('button', { name: 'サーバを停止' }).click();
  const confirm = page.getByRole('dialog', { name: 'サーバを停止' });
  await confirm.getByRole('button', { name: 'キャンセル' }).click();
  await expect(confirm).toBeHidden();
  await page.getByRole('button', { name: 'サーバを停止' }).click();
  await confirm.getByRole('button', { name: '停止する' }).click();
  await expect(page.getByTestId('stopped')).toBeVisible();
  // dew status は止まっていると失敗で終わる
  await expect
    .poll(() => {
      try {
        dew.run(['status']);
        return 'running';
      } catch {
        return 'stopped';
      }
    })
    .toBe('stopped');
});

test('タブバーを左端の縦並びにすると普段は隠れ、左端に寄せると出る', async ({ page, dew }) => {
  await start(page, dew);
  await open(page, 'h264_aac.mp4');
  await openPanel(page);
  await panel(page).getByRole('radio', { name: '左端に縦並び' }).check();
  await panel(page).getByRole('button', { name: '閉じる', exact: true }).click();
  const bar = page.getByTestId('taskbar');
  await page.mouse.move(800, 400);
  await expect(bar).not.toBeInViewport();
  await page.mouse.move(1, 400);
  await expect(bar).toBeInViewport();
  await expect(bar.getByRole('tab', { name: /h264_aac\.mp4/ })).toBeVisible();
});

test('操作パネルの上部に設定があり、キーで変えてもチェックボックスに反映される', async ({ page, dew }) => {
  await start(page, dew);
  await openPanel(page);
  await expect(panel(page).getByRole('heading', { level: 3 }).first()).toHaveText('設定');
  const hidden = panel(page).getByRole('checkbox', { name: '隠しファイルを表示' });
  const follow = panel(page).getByRole('checkbox', { name: '最新ファイルに追従' });
  await expect(hidden).not.toBeChecked();
  await page.keyboard.press('.');
  await expect(hidden).toBeChecked();
  await expect(current(page).getByRole('option', { name: '.hidden.png' })).toBeVisible();
  await hidden.uncheck();
  await expect(current(page).getByRole('option', { name: '.hidden.png' })).toBeHidden();
  await page.keyboard.press('n');
  await expect(follow).toBeChecked();
  await follow.uncheck();
  await expect(follow).not.toBeChecked();
});

test('キャンバスの操作パネルは設定と拡大・縮小・均等に並べるが上にある', async ({ page, dew }) => {
  await start(page, dew);
  await open(page, 'h264_aac.mp4');
  await openPanel(page);
  const headings = panel(page).getByRole('heading', { level: 3 });
  await expect(headings.first()).toHaveText('設定');
  const quick = panel(page).getByTestId('ops-quick');
  for (const name of ['拡大', '縮小', '均等に並べる']) await expect(quick.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
});
