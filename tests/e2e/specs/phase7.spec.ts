// フェーズ7の受け入れ基準(docs/spec.md 11章): CSV。100万行の応答時間は csv-perf.spec.ts、
// 解析・型の推定・SQL の組み立ては Rust のテスト(crates/server/src/csv)
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { cell, choose, filter, goCol, header, openCsv, rowNumbers, status } from '../lib/csv';
import { copyCsv, expect, reloadPage, start, test, writeConfig } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

// 基準1: 1万行の UTF-8 CSV が小規模モードで開き、ソート・フィルター・検索でサーバへの問い合わせが発生しない
test('1万行は小規模モードで開き、ソート・フィルター・検索でサーバに問い合わせない', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  const asked: string[] = [];
  // 表示設定の保存(PUT /api/csv/view)は問い合わせに含めない(ADR 0022)
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/csv/') && r.method() !== 'PUT') asked.push(u.pathname);
  });
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await expect(status(win)).toContainText('小規模');
  await expect(status(win)).toContainText('10,000 / 10,000 行');
  const before = asked.length;
  await goCol(page, win, 1);
  await page.keyboard.press('s');
  await expect(header(win, 1)).toHaveAttribute('aria-sort', 'ascending');
  await filter(page, 'contains', 'alpha');
  await expect(status(win)).not.toContainText('10,000 / 10,000 行');
  await page.keyboard.press('/');
  await win.getByRole('textbox', { name: '検索' }).fill('alpha1');
  await win.getByRole('textbox', { name: '検索' }).press('Enter');
  await expect(win.locator('[data-match="true"]').first()).toBeVisible();
  await page.keyboard.press('n');
  expect(asked.slice(before)).toEqual([]);
});

// 基準2: Excel が出力した Shift_JIS の CSV が文字化けせず、文字コードが Shift_JIS と表示される
test('Shift_JIS の CSV を文字化けせずに出し、文字コードを表示する', async ({ page, dew }) => {
  copyCsv(dew, ['sjis.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'sjis.csv');
  await expect(header(win, 0)).toContainText('名前');
  await expect(cell(win, 1, 0)).toHaveText('山田太郎');
  await expect(cell(win, 2, 2)).toHaveText('大阪府大阪市（北区）');
  await expect(status(win)).toContainText('Shift_JIS');
});

// 基準3: 改行・カンマ・"" を含む引用符付きのセルが、1つのセルとして正しく表示される
test('引用符の中の改行・カンマ・"" を1つのセルとして出し、Enter で全文を見る', async ({ page, dew }) => {
  copyCsv(dew, ['quoted.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'quoted.csv');
  await expect(status(win)).toContainText('3 / 3 行');
  await expect(cell(win, 2, 1)).toHaveText('カンマ, を含む');
  await expect(cell(win, 3, 1)).toHaveText('引用符 "です"');
  await goCol(page, win, 1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('csv-inspector')).toHaveText('1行目\n2行目');
});

// 基準4: 列数が不揃いな行を含む CSV が開き、警告が表示される
test('列数が不揃いな行があっても開き、警告を出す', async ({ page, dew }) => {
  copyCsv(dew, ['ragged.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'ragged.csv');
  await expect(status(win)).toContainText('列数が不揃いな行: 3 行');
  // 多い列は「列N」として足し、足りない列は空(null は —)
  await expect(header(win, 3)).toHaveText(/列4/);
  await expect(header(win, 4)).toHaveText(/列5/);
  await expect(cell(win, 2, 2)).toHaveText('—');
  await expect(cell(win, 4, 4)).toHaveText('14');
});

/** 両方のモードで同じ操作をする: name の昇順、score を第2キー、flag が true、score > 0 */
async function sameQuery(page: Page, win: Locator) {
  await goCol(page, win, 1);
  await page.keyboard.press('s');
  await goCol(page, win, 2);
  await page.keyboard.press('S');
  await filter(page, 'gt', '0');
  await goCol(page, win, 4);
  await filter(page, 'true');
  await expect(header(win, 2)).toHaveAttribute('aria-sort', 'ascending');
}

// 基準6: 同じデータに同じ条件を付けたとき、大規模モードと小規模モードの結果(並び順を含む)が一致する(閾値を変えてテストする)
test('大規模モードと小規模モードで、同じ条件の結果と並び順が一致する', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  let win = await openCsv(page, dew, 'rows10k.csv');
  await expect(status(win)).toContainText('小規模');
  await sameQuery(page, win);
  const small = { status: await win.getByTestId('csv-rows').textContent(), rows: await rowNumbers(win) };
  expect(small.rows.length).toBeGreaterThan(10);
  // 閾値を下げて起動し直すと、同じファイルが大規模モードになる(表示設定は dew stop で消える)
  dew.stop();
  writeConfig(dew, 'csv_small_max_rows = 100\n');
  dew.restart();
  await reloadPage(page);
  win = await openCsv(page, dew, 'rows10k.csv');
  await expect(status(win)).toContainText('大規模');
  await sameQuery(page, win);
  await expect(win.getByTestId('csv-rows')).toHaveText(small.status!);
  await expect.poll(() => rowNumbers(win).then((r) => r.slice(0, small.rows.length))).toEqual(small.rows);
});

// 基準7: 列名や値に " ' ; -- を含んでいても、フィルター・検索が正しく動き、SQL のエラーにならない(両方のモードで)
for (const mode of ['小規模', '大規模'] as const) {
  test(`列名や値の記号でフィルター・検索が壊れない(${mode})`, async ({ page, dew }) => {
    copyCsv(dew, ['symbols.csv']);
    if (mode === '大規模') {
      dew.stop();
      writeConfig(dew, 'csv_small_max_rows = 1\n');
      dew.restart();
    }
    await start(page, dew);
    const win = await openCsv(page, dew, 'symbols.csv');
    await expect(status(win)).toContainText(mode);
    await expect(header(win, 0)).toContainText('say "hi"');
    await expect(header(win, 1)).toContainText("it's");
    await filter(page, 'contains', '"yes"');
    await expect(win.getByTestId('csv-rows')).toHaveText('1 / 3 行');
    await page.keyboard.press('F');
    await goCol(page, win, 3);
    await filter(page, 'contains', '--');
    await expect(win.getByTestId('csv-rows')).toHaveText('2 / 3 行');
    await page.keyboard.press('F');
    await goCol(page, win, 1);
    await filter(page, 'equals', "'");
    await expect(win.getByTestId('csv-rows')).toHaveText('0 / 3 行');
    await page.keyboard.press('F');
    await page.keyboard.press('/');
    await win.getByRole('textbox', { name: '検索' }).fill("'; DROP");
    await win.getByRole('textbox', { name: '検索' }).press('Enter');
    await expect(win.locator('[data-match="true"]')).toHaveCount(1);
    await expect(win.getByTestId('csv-error')).toHaveCount(0);
    await expect(win.getByTestId('csv-rows')).toHaveText('3 / 3 行');
  });
}

// 基準8: 丸め・表示名・強調・列の固定で表示だけが変わり、y でコピーした値は元の値のまま
test('丸め・表示名・マーク・固定は表示だけを変え、y は元の値をコピーする', async ({ page, dew, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await goCol(page, win, 2);
  const score = cell(win, 1, 2);
  const original = (await score.textContent())!;
  expect(original).toMatch(/^-?\d+\.\d{6}$/);
  // 「そのまま」は列の最大の桁数(6)。- で1桁ずつ減らす
  for (let i = 0; i < 4; i++) await page.keyboard.press('-');
  await expect(score).toHaveText(/^-?\d+\.\d{2}$/);
  await page.keyboard.press('r');
  await win.getByRole('textbox', { name: '表示名' }).fill('スコア');
  await win.getByRole('textbox', { name: '表示名' }).press('Enter');
  await expect(header(win, 2)).toContainText('スコア');
  await expect(header(win, 2)).toHaveAttribute('title', /score/);
  await page.keyboard.press('m');
  await expect(win.locator('[role="row"][data-row="1"]')).toHaveAttribute('data-marked', 'true');
  await page.keyboard.press('p');
  await expect(header(win, 2)).toHaveAttribute('data-pinned', 'true');
  await page.keyboard.press('y');
  await expect(page.getByRole('status').filter({ hasText: `コピーしました: ${original}` })).toBeVisible();
  if (browserName === 'chromium') await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(original);
});

// 基準9: タブを再読み込みしても表示設定が戻る。dew stop のあとは初期状態になる
test('表示設定は再読み込みしても戻り、dew stop で初期状態になる', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  let win = await openCsv(page, dew, 'rows10k.csv');
  await goCol(page, win, 1);
  await page.keyboard.press('s');
  await page.keyboard.press('r');
  await win.getByRole('textbox', { name: '表示名' }).fill('名前');
  await win.getByRole('textbox', { name: '表示名' }).press('Enter');
  await expect(header(win, 1)).toContainText('名前');
  await reloadPage(page);
  win = await openCsv(page, dew, 'rows10k.csv');
  await expect(header(win, 1)).toContainText('名前');
  await expect(header(win, 1)).toHaveAttribute('aria-sort', 'ascending');
  dew.stop();
  dew.restart();
  await reloadPage(page);
  win = await openCsv(page, dew, 'rows10k.csv');
  await expect(header(win, 1)).toHaveText(/^name/);
  await expect(header(win, 1)).not.toHaveAttribute('aria-sort', 'ascending');
});

// 基準10: 1,000 列の CSV で、描画される列が画面内の分だけになる
test('1,000 列でも、描画する列は画面内の分だけ', async ({ page, dew }) => {
  copyCsv(dew, ['wide.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'wide.csv');
  await expect(status(win)).toContainText('1,000 列');
  const drawn = await win.getByRole('columnheader').count();
  expect(drawn).toBeGreaterThan(3);
  expect(drawn).toBeLessThan(60);
  // $ で末尾の列へ
  await page.keyboard.press('$');
  await expect(header(win, 999)).toBeInViewport();
  expect(await win.getByRole('columnheader').count()).toBeLessThan(60);
});

// 基準11: hjkl で画面外のセルへ移動すると、自動でスクロールする
test('hjkl で画面外のセルへ移ると、自動でスクロールする', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv', 'wide.csv']);
  await start(page, dew);
  let win = await openCsv(page, dew, 'rows10k.csv');
  for (let i = 0; i < 80; i++) await page.keyboard.press('j');
  await expect(cell(win, 81, 0)).toBeInViewport();
  await expect(cell(win, 81, 0)).toHaveAttribute('aria-selected', 'true');
  for (let i = 0; i < 40; i++) await page.keyboard.press('k');
  await expect(cell(win, 41, 0)).toBeInViewport();
  win = await openCsv(page, dew, 'wide.csv');
  for (let i = 0; i < 30; i++) await page.keyboard.press('l');
  await expect(cell(win, 1, 30)).toBeInViewport();
  await expect(cell(win, 1, 30)).toHaveAttribute('aria-selected', 'true');
});

// 基準12: ビルド結果の初期チャンクに、TanStack Table と TanStack Virtual が含まれない
test('初期チャンクに TanStack Table と TanStack Virtual を含めない', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'ブラウザを使わない検査なので1回だけ');
  const dist = resolve(import.meta.dirname, '../../../web/dist');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const entry = html.match(/src="\/(assets\/[^"]+\.js)"/)![1]!;
  const code = readFileSync(join(dist, entry), 'utf8');
  // どちらのライブラリにも必ずある名前(プロパティ名は圧縮しても残る)
  for (const s of ['getCoreRowModel', 'getSortedRowModel', 'measureElement', 'getVirtualItems']) expect(code).not.toContain(s);
  const all = readdirSync(join(dist, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dist, 'assets', f), 'utf8'))
    .join('\n');
  for (const s of ['getCoreRowModel', 'getVirtualItems']) expect(all).toContain(s);
});

// ---- 受け入れ基準のほかに、spec 15・16 章の動き ----

test('TSV はタブ区切りで読み、区切り文字を表示する', async ({ page, dew }) => {
  copyCsv(dew, ['tabs.tsv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'tabs.tsv');
  await expect(cell(win, 2, 1)).toHaveText('2');
  await expect(status(win)).toContainText('タブ');
});

test('ファイルを書き換えると1秒以内に読み直し、選んでいたセルを保つ', async ({ page, dew }) => {
  const dir = copyCsv(dew, ['quoted.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'quoted.csv');
  await page.keyboard.press('j');
  appendFileSync(join(dir, 'quoted.csv'), 'd,追加した行\n');
  await expect(cell(win, 4, 1)).toHaveText('追加した行', { timeout: 1500 });
  await expect(cell(win, 2, 0)).toHaveAttribute('aria-selected', 'true');
  // 行が減って範囲外になったら、末尾に寄せる
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  writeFileSync(join(dir, 'quoted.csv'), 'key,text\na,x\n');
  await expect(cell(win, 1, 1)).toHaveText('x', { timeout: 1500 });
  await expect(cell(win, 1, 0)).toHaveAttribute('aria-selected', 'true');
});

test('Home のプレビューに CSV の先頭を小さな表で出す', async ({ page, dew }) => {
  copyCsv(dew, ['sjis.csv', 'wide.csv']);
  await start(page, dew);
  await page.getByTestId('col-current').getByRole('option', { name: 'csv' }).dblclick();
  await page.getByTestId('col-current').getByRole('option', { name: 'sjis.csv' }).click();
  const preview = page.getByTestId('csv-preview');
  await expect(preview).toContainText('山田太郎');
  await expect(preview).toContainText('Shift_JIS');
  await page.getByTestId('col-current').getByRole('option', { name: 'wide.csv' }).click();
  // 最大10列
  await expect(preview.getByRole('columnheader')).toHaveCount(10);
});

// マウスだけで: 列の見出しのメニューで並べ替え・隠す、操作パネルの CSV の節でフィルター
test('列の見出しのメニューと操作パネルで、マウスだけで操作できる', async ({ page, dew }) => {
  copyCsv(dew, ['rows10k.csv']);
  await start(page, dew);
  const win = await openCsv(page, dew, 'rows10k.csv');
  await header(win, 1).hover();
  await header(win, 1).getByRole('button', { name: '列の操作' }).click();
  await page.getByRole('menuitem', { name: /^並べ替え/ }).click();
  await expect(header(win, 1)).toHaveAttribute('aria-sort', 'ascending');
  await header(win, 5).getByRole('button', { name: '列の操作' }).click({ force: true });
  await page.getByRole('menuitem', { name: /^隠す/ }).click();
  await expect(header(win, 5)).toHaveCount(0);
  // 見出しを押すと、その列を選ぶ(score には空のセルがある)
  await header(win, 2).click();
  await page.getByRole('button', { name: '操作パネル' }).click();
  const csv = page.getByTestId('ops-panel').getByTestId('ops-all').locator('section').last();
  await expect(csv.locator('h3')).toHaveText(/^CSV/);
  await csv.getByRole('button', { name: /^フィルター f/ }).click();
  const dialog = page.getByRole('dialog', { name: /フィルター/ });
  await choose(page, dialog, '条件', 'notEmpty');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(win.getByTestId('csv-rows')).not.toHaveText('10,000 / 10,000 行');
});
