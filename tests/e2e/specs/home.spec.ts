// フェーズ1の受け入れ基準(docs/spec.md 11章): Home
import { copyFileSync, mkdirSync } from 'node:fs';
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
  // h で戻ると、出てきたディレクトリが選ばれている(移動は一覧を読めてから)
  await page.keyboard.press('h');
  await expect.poll(() => selected(page)).toBe('sub');

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

// 右カラムに中身を出しているディレクトリにファイルができたら、プレビューも1秒以内に変わる
// (録画の開始で空の dew-recordings/ ができ、止めたときにできた MP4 が出ず「空のディレクトリです」のままだった)
test('プレビュー中のディレクトリにできたファイルが1秒以内にプレビューに出る', async ({ page, dew }) => {
  await start(page, dew);
  mkdirSync(join(dew.root, 'out'));
  const out = current(page).getByRole('option', { name: /^out/ });
  await out.click();
  const preview = page.getByTestId('col-preview');
  await expect(preview).toContainText('空のディレクトリです');
  copyFileSync(join(dew.root, 'image.png'), join(dew.root, 'out', 'result.png'));
  await expect(preview).toContainText('result.png', { timeout: 1000 });
});

// キャンバスから Tab で戻ると Enter を押したときのまま。H では初期位置(4.1、5.3)
test('キャンバスから戻ると Home の状態が残っている', async ({ page, dew }) => {
  await start(page, dew);
  await current(page).getByRole('option', { name: 'sub' }).click();
  await page.keyboard.press('l');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  await open(page, 'nested.webp');

  await page.keyboard.press('Tab');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  expect(await selected(page)).toBe('nested.webp');

  // Tab は Home ⇄ キャンバスの切替。ウィンドウは残っている
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('player-window')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);

  // H は Home の初期位置へ。キャンバスの H は何もしない(Tab で Home に戻ってから H。ADR 0030)
  await page.keyboard.press('Tab');
  await page.keyboard.press('H');
  await expect(page.getByTestId('player-window')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('H');
  await expect(current(page).getByRole('option', { name: 'sub' })).toBeVisible();
  await expect(page.getByTestId('player-window')).toBeHidden();
});

// 履歴ウィンドウ(4.4): 直近に開いたファイルを新しい順に出し、Home と同じキーで開く。q で閉じる
test('履歴ウィンドウから開き直せる', async ({ page, dew }) => {
  await start(page, dew);
  await open(page, 'h264_aac.mp4');
  await page.keyboard.press('Tab');
  await open(page, 'image.png');

  await page.keyboard.press('r');
  const history = page.getByTestId('history');
  await expect(history).toBeVisible();
  await expect(history.getByTestId('history-list').getByRole('option')).toHaveText(['image.png', 'h264_aac.mp4']);
  await expect(history.getByTestId('col-preview').locator('img')).toBeVisible();
  await page.keyboard.press('q');
  await expect(history).toBeHidden();

  // Home からも開け、閉じるボタンがある
  await page.keyboard.press('Tab');
  await page.keyboard.press('r');
  await expect(history).toBeVisible();
  await history.getByRole('button', { name: '閉じる' }).click();
  await expect(history).toBeHidden();

  await page.keyboard.press('r');
  await expect(history.getByRole('option')).toHaveCount(2);
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(history).toBeHidden();
  await expect(page.getByTestId('player-window').filter({ hasText: 'h264_aac.mp4' })).toHaveCount(2);
});

test('Home のバーの絞り込み・キャンバスへのボタン', async ({ page, dew }) => {
  await start(page, dew);
  await page.getByRole('button', { name: '絞り込み', exact: true }).click();
  await page.keyboard.type('mp4');
  await expect(current(page).getByRole('option')).toHaveText(['broken.mp4', 'h264_aac.mp4', 'mp4v.mp4']);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'キャンバスへ', exact: true }).click();
  await expect(page.getByTestId('canvas-area')).toBeVisible();
});

test('パンくずで閲覧範囲の外を押すとメッセージだけ出て移動しない', async ({ page, dew }) => {
  await start(page, dew);
  await expect(current(page).getByRole('option', { name: 'sub' })).toBeVisible();
  await page.getByRole('navigation', { name: 'path' }).getByRole('link', { name: '/', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('閲覧範囲の外');
  await expect(current(page).getByRole('option', { name: 'sub' })).toBeVisible();
  await page.keyboard.press('j');
  expect(await selected(page)).toBe('broken.mp4');
});

test('Home のバー: キャンバスへは左端、右は 検索・履歴・グリッド・ヒント・その他 の順。初期位置に印', async ({ page, dew }) => {
  await start(page, dew);
  const x = async (name: string) => (await page.getByRole('button', { name, exact: true }).first().boundingBox())!.x;
  const crumbs = await page.getByRole('navigation', { name: 'path' }).boundingBox();
  expect(await x('キャンバスへ')).toBeLessThan(crumbs!.x);
  const order = ['保存', '絞り込み', '履歴', 'グリッド表示', 'キー一覧', '設定 / 操作パネル'];
  const xs = await Promise.all(order.map(x));
  expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  // テストでは HOME が範囲外なので、初期位置は --root の場所(パンくずの最後)
  await expect(page.getByTestId('crumb-initial')).toHaveText(dew.root.split('/').at(-1)!);
});

test('Shift+クリックで範囲を、Ctrl+クリックで1つずつ複数選択できる', async ({ page, dew }) => {
  await start(page, dew);
  const opt = (name: string) => current(page).getByRole('option', { name });
  const marked = current(page).locator('[data-marked="true"]');
  await opt('h264_aac.mp4').click();
  await opt('image.png').click({ modifiers: ['Shift'] });
  await expect(marked).toHaveText(['h264_aac.mp4', 'image.jpg', 'image.png']);
  await opt('image.jpg').click({ modifiers: ['Control'] });
  await expect(marked).toHaveText(['h264_aac.mp4', 'image.png']);
  await opt('mp4v.mp4').click({ modifiers: ['Control'] });
  await expect(marked).toHaveText(['h264_aac.mp4', 'image.png', 'mp4v.mp4']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player-window')).toHaveCount(3);
});

test('別のディレクトリへ移っても複数選択は残り、まとめて開ける', async ({ page, dew }) => {
  await start(page, dew);
  await current(page).getByRole('option', { name: 'h264_aac.mp4' }).click({ modifiers: ['Control'] });
  await current(page).getByRole('option', { name: 'sub' }).click();
  await page.keyboard.press('l');
  await expect(current(page).getByRole('option')).toHaveText(['nested.webp']);
  await page.keyboard.press(' ');
  await expect(page.locator('.home-status')).toContainText('2 件を選択中');
  await page.keyboard.press('h');
  await expect(current(page).locator('[data-marked="true"]')).toHaveText(['h264_aac.mp4']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player-window')).toHaveCount(2);
});
