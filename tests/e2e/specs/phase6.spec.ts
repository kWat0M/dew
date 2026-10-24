// フェーズ6の受け入れ基準(docs/spec.md 11章): ドキュメントウィンドウと Markdown。文字コードの判定は Rust のテスト(crates/dew/tests/phase6.rs)
import { appendFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { copyMd, current, expect, selected, start, test, type Dew } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });

/** ドキュメントウィンドウ。名前はファイル名 */
function docWindow(page: Page, name: string) {
  return page.getByTestId('document-window').and(page.getByLabel(name, { exact: true }));
}

/** `dew <ファイル>` で開き、描画を待つ */
async function openDoc(page: Page, dew: Dew, rel: string) {
  dew.run([join(dew.root, 'md', rel)]);
  const win = docWindow(page, rel.split('/').pop()!);
  await expect(win.getByTestId('doc-body')).toBeVisible();
  return win;
}

const scrollTop = (win: Locator) => win.getByTestId('doc-scroll').evaluate((el) => el.scrollTop);

// 基準1: 見出し・表・タスクリスト・打ち消し線・数式・色分けされたコード・フロントマター
test('Markdown の各要素が描画される', async ({ page, dew }, info) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'all.md');
  const body = win.getByTestId('doc-body');
  await expect(body.locator('h1')).toHaveText('全要素の見本');
  await expect(body.locator('table td').first()).toHaveText('alpha');
  // タスクリストのチェックボックスは表示だけ
  await expect(body.locator('input[type=checkbox]')).toHaveCount(2);
  await expect(body.locator('input[type=checkbox]').first()).toBeDisabled();
  await expect(body.locator('del')).toHaveText('打ち消し線');
  await expect(body.locator('.katex').first()).toBeVisible();
  await expect(body.locator('.katex-display')).toHaveCount(1);
  // 誤った数式は、その式だけ error 色の文字にする
  await expect(body.locator('.katex-error')).toHaveCount(1);
  await expect(body.locator('pre code.hljs .hljs-keyword').first()).toBeVisible();
  // フロントマターは本文に出さず、上部のメタデータに出す
  await expect(body).not.toContainText('tags:');
  await expect(win.getByTestId('doc-frontmatter')).toContainText('title: 全要素の見本');
  // 見た目は人が確かめる(スクリーンショットをテスト結果に残す)
  await info.attach('all.md', { body: await win.screenshot({ path: info.outputPath('all.png') }), contentType: 'image/png' });
});

// 基準2: javascript: のリンク、生の <script>、<img onerror> が実行されない
test('危険なリンクや HTML が実行されない', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'danger.md');
  const body = win.getByTestId('doc-body');
  await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(body.locator('script, img[onerror]')).toHaveCount(0);
  // javascript: のリンクは文字だけ
  await expect(body).toContainText('スクリプトのリンク');
  await body.getByText('スクリプトのリンク').click();
  await expect(body.locator('a[href^="data:"]')).toHaveCount(0);
  // 外部のリンクは新しいタブで開く
  const ext = body.getByRole('link', { name: '外部のリンク' });
  await expect(ext).toHaveAttribute('target', '_blank');
  await expect(ext).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => (window as unknown as { __dewPwned?: number }).__dewPwned)).toBeUndefined();
});

// 基準3: 相対パスの画像が表示され、範囲外は表示されず、外部の画像はクリックするまで要求しない
test('画像: 相対は表示、範囲外は出さず、外部はクリックまで読み込まない', async ({ page, dew }) => {
  copyMd(dew);
  const external: string[] = [];
  page.on('request', (r) => r.url().includes('example.invalid') && external.push(r.url()));
  await start(page, dew);
  const win = await openDoc(page, dew, 'images.md');
  const body = win.getByTestId('doc-body');
  const rel = body.getByRole('img', { name: '相対の画像' });
  await expect.poll(() => rel.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  await expect(body.getByRole('img', { name: '範囲外の画像' })).toHaveCount(0);
  await expect(body).toContainText('閲覧範囲外');
  await expect.poll(() => body.getByRole('img', { name: 'data の画像' }).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  const placeholder = body.getByTestId('external-image');
  await expect(placeholder).toContainText('example.invalid');
  await expect(placeholder).toContainText('クリックで読み込む');
  await page.waitForTimeout(500);
  expect(external).toEqual([]);
  await placeholder.click();
  await expect.poll(() => external.length).toBeGreaterThan(0);
});

// 基準4: f でヒントを出し、文字を入力すると相対リンクの Markdown へ移動する。H で戻ると元のスクロール位置に戻る
test('リンクヒントで移動し、H で元の位置へ戻る', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  await openDoc(page, dew, 'a.md');
  // 移動すると窓の名前が変わるので、名前ではなく(1つだけの)ドキュメントウィンドウで探す
  const win = page.getByTestId('document-window');
  const link = win.getByRole('link', { name: 'B へ移動' });
  // 開いた直後から入力モードなので、d で半画面ずつ下がる
  await expect(async () => {
    await page.keyboard.press('d');
    await expect(link).toBeInViewport({ timeout: 200 });
  }).toPass();
  const before = await scrollTop(win);
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press('f');
  const hint = win.getByTestId('link-hint').and(win.locator('[data-href="docs/b.md"]'));
  await expect(hint).toBeVisible();
  for (const ch of (await hint.textContent())!) await page.keyboard.press(ch);
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('B の文書');
  await expect(win.getByTestId('window-title')).toContainText('b.md');
  await expect(win.getByTestId('link-hint')).toHaveCount(0);
  await page.keyboard.press('H');
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('A の文書');
  await expect.poll(() => scrollTop(win)).toBe(before);
  // L で進む
  await page.keyboard.press('L');
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('B の文書');
});

/** 見出しがスクロールの上端近くにあるか */
async function headingAtTop(win: Locator, text: string) {
  return win.getByTestId('doc-scroll').evaluate((el, t) => {
    const h = [...el.querySelectorAll('h1, h2, h3')].find((x) => x.textContent === t);
    if (!h) return false;
    const d = h.getBoundingClientRect().top - el.getBoundingClientRect().top;
    return d >= -2 && d < 40;
  }, text);
}

// 基準5: #見出し のリンクと目次(o)で、その見出しへスクロールする
test('ページ内リンクと目次で見出しへ移動する', async ({ page, dew }) => {
  copyMd(dew);
  await page.setViewportSize({ width: 1280, height: 600 });
  await start(page, dew);
  const win = await openDoc(page, dew, 'all.md');
  await win.getByRole('link', { name: '見出しへ' }).click();
  await expect.poll(() => headingAtTop(win, '表')).toBe(true);
  await page.keyboard.press('o');
  const toc = page.getByTestId('doc-toc');
  await expect(toc).toBeVisible();
  // 見出しは「全要素の見本 / 表 / タスクリスト / 数式 / コード」。今の位置(表)から始まり、j で下へ
  await expect(toc.getByRole('option', { selected: true })).toHaveText('表');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(toc.getByRole('option', { selected: true })).toHaveText('コード');
  await page.keyboard.press('Enter');
  await expect(toc).toBeHidden();
  await expect.poll(() => headingAtTop(win, 'コード')).toBe(true);
  // [ で前の見出しへ
  await page.keyboard.press('[');
  await expect.poll(() => headingAtTop(win, '数式')).toBe(true);
});

// 基準6: ファイルを書き換えると1秒以内に描画し直し、スクロール位置が変わらない
test('ファイルを書き換えると、位置を保って1秒以内に描画し直す', async ({ page, dew }) => {
  const dir = copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'a.md');
  for (let i = 0; i < 4; i++) await page.keyboard.press('d');
  await expect.poll(() => scrollTop(win)).toBeGreaterThan(0);
  const before = await scrollTop(win);
  const t0 = Date.now();
  appendFileSync(join(dir, 'a.md'), '\n最後に足した段落。\n');
  await expect(win.getByTestId('doc-body')).toContainText('最後に足した段落。', { timeout: 1000 });
  console.log(`描画し直すまで ${Date.now() - t0} ms`);
  expect(await scrollTop(win)).toBe(before);
});

// 基準7: Shift_JIS の Markdown が文字化けせず、ウィンドウ下部に Shift_JIS と出る
test('Shift_JIS の Markdown を文字化けせずに出す', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'sjis.md');
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('日本語の見出し');
  await expect(win.getByTestId('doc-body')).toContainText('（全角括弧）');
  await expect(win.getByTestId('doc-encoding')).toHaveText('Shift_JIS');
});

// 基準8: 開いた直後から j でスクロールでき、q か Ctrl+[ で抜けたあとは w や Tab のキャンバス操作が効く
test('開いた直後から j で読め、q / Ctrl+[ で抜けるとキャンバスの操作が効く', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  // Home から Enter で開く(yazi から開いたときと同じく、すぐ読めること)
  await current(page).getByRole('option', { name: 'md' }).click();
  await page.keyboard.press('l');
  await current(page).getByRole('option', { name: 'a.md' }).click();
  await page.keyboard.press('Enter');
  const win = docWindow(page, 'a.md');
  await expect(win.getByTestId('doc-body')).toBeVisible();
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.press('j');
  await expect.poll(() => scrollTop(win)).toBeGreaterThan(0);
  // 抜けるキーは1回で1段ずつ戻る: ヒントを閉じ、次に入力モードを抜ける(ADR 0030)
  await page.keyboard.press('f');
  await expect(win.getByTestId('link-hint').first()).toBeVisible();
  await expect(page.getByTestId('hint-bar').filter({ visible: true })).toContainText('ヒントを閉じる');
  await page.keyboard.press('Escape');
  await expect(win.getByTestId('link-hint')).toHaveCount(0);
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.press('Control+BracketLeft');
  await expect(win).toHaveAttribute('data-input', 'false');
  await expect(page.getByTestId('hint-bar').filter({ visible: true })).not.toContainText('ヒントを閉じる');
  // ノーマルモードの再生キーは効かず、i で操作できると1回だけ知らせる
  const top = await scrollTop(win);
  await page.keyboard.press('j');
  await expect(page.getByRole('status').filter({ hasText: 'i で操作できます' })).toBeVisible();
  expect(await scrollTop(win)).toBe(top);
  await page.keyboard.press('w');
  await expect(page.getByTestId('window-mode')).toBeVisible();
  await page.keyboard.press('q');
  // i で入り直し、Ctrl+[ で抜ける
  await page.keyboard.press('i');
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.press('Control+BracketLeft');
  await expect(win).toHaveAttribute('data-input', 'false');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('col-current')).toBeVisible();
});

// 15.2: 同じファイルがすでにキャンバスにあれば、新しく開かずにそのウィンドウにフォーカスする
test('同じ文書は2つ目を開かずにフォーカスする', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  await openDoc(page, dew, 'all.md');
  await openDoc(page, dew, 'sjis.md');
  dew.run([join(dew.root, 'md', 'all.md')]);
  await expect(page.getByTestId('document-window')).toHaveCount(2);
  await expect(docWindow(page, 'all.md')).toHaveAttribute('data-focused', 'true');
});

/** ヒントを出し、指定したリンク(data-href)のヒントの文字を打つ */
async function pickHint(page: Page, win: Locator, key: 'f' | 'F', href: string) {
  await page.keyboard.press(key);
  const hint = win.getByTestId('link-hint').and(win.locator(`[data-href="${href}"]`));
  await expect(hint).toBeVisible();
  for (const ch of (await hint.textContent())!) await page.keyboard.press(ch);
}

// ディレクトリへのリンクで Home へ移ったら、すぐに Home のキーが効く(文書の入力モードがキーを横取りしない)
test('ディレクトリのリンクで Home へ移ると、すぐにキーが効く', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'docs/b.md');
  await expect(win).toHaveAttribute('data-input', 'true');
  await pickHint(page, win, 'f', '..');
  await expect(current(page).getByRole('option', { name: 'a.md' })).toBeVisible();
  const before = await selected(page);
  await page.keyboard.press('j');
  await expect.poll(() => selected(page)).not.toBe(before);
  // キャンバスへ戻ると、文書はまた入力モード
  await page.keyboard.press('Tab');
  await expect(win).toHaveAttribute('data-input', 'true');
});

// 入力モードは q でも、ヒントは Backspace でも閉じる
test('q で入力モードを抜け、Backspace でヒントを閉じる', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'all.md');
  await page.keyboard.press('f');
  await expect(win.getByTestId('link-hint').first()).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(win.getByTestId('link-hint')).toHaveCount(0);
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.press('q');
  await expect(win).toHaveAttribute('data-input', 'false');
});

// f で選んだ画像は同じウィンドウに出し、H で文書へ戻る。F なら新しいウィンドウで開く
test('f の画像はウィンドウの中に出し、H で戻る。F は新しいウィンドウ', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  await openDoc(page, dew, 'a.md');
  const win = page.getByTestId('document-window');
  const link = win.getByRole('link', { name: '画像を見る' });
  await expect(async () => {
    await page.keyboard.press('d');
    await expect(link).toBeInViewport({ timeout: 200 });
  }).toPass();
  const before = await scrollTop(win);
  await pickHint(page, win, 'f', 'img/pic.png');
  await expect.poll(() => win.getByTestId('doc-image').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  await expect(win.getByTestId('window-title')).toContainText('pic.png');
  await expect(page.getByTestId('document-window')).toHaveCount(1);
  await page.keyboard.press('H');
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('A の文書');
  await expect.poll(() => scrollTop(win)).toBe(before);
  await pickHint(page, win, 'F', 'img/pic.png');
  await expect(page.getByTestId('player-window').filter({ hasText: 'pic.png' })).toBeVisible();
});

// コードブロックのコピーボタン。クリックでも、f のヒントでもコピーする
test('コードブロックをボタンと f でコピーする', async ({ page, dew, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'all.md');
  const buttons = win.getByTestId('code-copy');
  await expect(buttons).toHaveCount(2);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await buttons.first().click();
  await expect(page.getByRole('status').filter({ hasText: 'コードをコピーしました' })).toBeVisible();
  if (browserName === 'chromium') await expect.poll(clipboard).toContain('def hello(name: str)');
  // f のヒントでも選べる(マウスで押したので入力モードに入り直す)
  await page.keyboard.press('i');
  await buttons.last().scrollIntoViewIfNeeded();
  await page.keyboard.press('f');
  const hint = win.getByTestId('link-hint').and(win.locator(':not([data-href])')).last();
  await expect(hint).toBeVisible();
  for (const ch of (await hint.textContent())!) await page.keyboard.press(ch);
  if (browserName === 'chromium') await expect.poll(clipboard).toContain('println!');
  else await expect(page.getByRole('status').filter({ hasText: 'コードをコピーしました' })).toBeVisible();
});

// マウスだけで: リンクで移り、バーのボタンで戻る・進む。中クリックは dew の新しいウィンドウ
// (戻る・進むはブラウザの履歴と同じ。サイドボタンを含めて specs/history.spec.ts で確かめる)
test('バーのボタンで戻る・進み、中クリックで新しいウィンドウに開く', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  await openDoc(page, dew, 'docs/b.md');
  const win = page.getByTestId('document-window');
  const h1 = win.getByTestId('doc-body').locator('h1');
  const back = win.getByRole('button', { name: /^戻る/ });
  const forward = win.getByRole('button', { name: /^進む/ });
  await expect(forward).toBeDisabled();
  await win.getByRole('link', { name: 'A へ戻る' }).click();
  await expect(h1).toHaveText('A の文書');
  await back.click();
  await expect(h1).toHaveText('B の文書');
  await forward.click();
  await expect(h1).toHaveText('A の文書');
  await expect(forward).toBeDisabled();
  // 中クリック: ブラウザの新しいタブは開かず、dew の新しいウィンドウで開く
  const link = win.getByRole('link', { name: '全要素の見本へ' });
  await expect(link).toHaveAttribute('title', /中クリック/);
  await link.click({ button: 'middle' });
  await expect(docWindow(page, 'all.md')).toBeVisible();
  await expect(page.getByTestId('document-window')).toHaveCount(2);
  expect(page.context().pages()).toHaveLength(1);
});

// 検索・目次・文字の大きさは、下部のバーのボタンでも操作できる
test('下部のバーのボタンで検索・目次・文字の大きさを変える', async ({ page, dew }) => {
  copyMd(dew);
  await page.setViewportSize({ width: 1280, height: 600 });
  await start(page, dew);
  const win = await openDoc(page, dew, 'all.md');
  const bar = win.getByTestId('doc-status');
  const scale = () => win.getByTestId('doc-scroll').evaluate((el) => getComputedStyle(el).getPropertyValue('--doc-scale').trim());
  await bar.getByRole('button', { name: /^文字を大きく/ }).click();
  expect(await scale()).toBe('1.15');
  await expect(bar.getByRole('button', { name: /^文字の大きさを元に戻す/ })).toHaveText('115%');
  await bar.getByRole('button', { name: /^文字を小さく/ }).click();
  await bar.getByRole('button', { name: /^文字を小さく/ }).click();
  expect(await scale()).toBe('0.9');
  await bar.getByRole('button', { name: /^文字の大きさを元に戻す/ }).click();
  expect(await scale()).toBe('1');
  // 目次: ボタンで開き、もう一度押すと閉じる。項目のクリックで移動する
  const tocButton = bar.getByRole('button', { name: /^目次/ });
  await tocButton.click();
  const toc = page.getByTestId('doc-toc');
  await expect(toc).toBeVisible();
  await tocButton.click();
  await expect(toc).toBeHidden();
  await tocButton.click();
  await toc.getByRole('option', { name: 'コード' }).click();
  await expect(toc).toBeHidden();
  await expect.poll(() => headingAtTop(win, 'コード')).toBe(true);
  // 検索: ボタンで欄を開き、Enter で確定。一致が2つ以上あれば、前・次のボタンで移る
  await bar.getByRole('button', { name: /^ページ内を検索/ }).click();
  // python のコードブロックに hello が2つある
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect(bar).toContainText('1 / 2');
  await bar.getByRole('button', { name: /^次の一致/ }).click();
  await expect(bar).toContainText('2 / 2');
  await bar.getByRole('button', { name: /^前の一致/ }).click();
  await expect(bar).toContainText('1 / 2');
});

// 操作パネルの一番下に、フォーカス中の文書の操作(Markdown の節)を出す
test('操作パネルの Markdown の節から文書を操作する', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'a.md');
  await page.keyboard.press('q');
  await page.getByRole('button', { name: '操作パネル' }).click();
  const sections = page.getByTestId('ops-panel').getByTestId('ops-all').locator('section');
  const md = sections.last();
  await expect(md.locator('h3')).toHaveText(/^Markdown/);
  await md.getByRole('button', { name: /^末尾へ/ }).click();
  await expect.poll(() => scrollTop(win)).toBeGreaterThan(0);
  await md.getByRole('button', { name: /^先頭へ/ }).click();
  await expect.poll(() => scrollTop(win)).toBe(0);
  // リンクヒントは続けてキーで選ぶので、押すと入力モードに入る
  await md.getByRole('button', { name: /^リンクを選んで開く/ }).click();
  await expect(win.getByTestId('link-hint').first()).toBeVisible();
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.press('Backspace');
  await expect(win.getByTestId('link-hint')).toHaveCount(0);
  // 文書以外にフォーカスすると、節は出ない
  dew.run([join(dew.root, 'image.png')]);
  await expect(page.getByTestId('player-window')).toHaveAttribute('data-focused', 'true');
  await expect(sections.last().locator('h3')).not.toHaveText(/^Markdown/);
});

// 15.4: ファイルが削除されたら、最後の内容を残して「削除されました」と出す
test('削除された文書は最後の内容を残す', async ({ page, dew }) => {
  const dir = copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'all.md');
  rmSync(join(dir, 'all.md'));
  await expect(win.getByTestId('doc-status')).toContainText('削除されました');
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('全要素の見本');
});

// 15.8: 文字コードは手で切り替えられる
test('文字コードを手で切り替える', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'sjis.md');
  await win.getByTestId('doc-encoding').click();
  await page.getByRole('menuitemradio', { name: 'UTF-8' }).click();
  await expect(win.getByTestId('doc-encoding')).toHaveText('UTF-8');
  await expect(win.getByTestId('doc-body')).not.toContainText('日本語の見出し');
  await win.getByTestId('doc-encoding').click();
  await page.getByRole('menuitemradio', { name: /Shift_JIS/ }).click();
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('日本語の見出し');
});

// 入力モードの e で、文字コードを UTF-8 → Shift_JIS → EUC-JP の順に切り替える
test('e で文字コードを順に切り替える', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  const win = await openDoc(page, dew, 'sjis.md');
  const encoding = win.getByTestId('doc-encoding');
  await page.keyboard.press('e');
  await expect(encoding).toHaveText('EUC-JP');
  await expect(page.getByRole('status').filter({ hasText: '文字コード: EUC-JP' })).toBeVisible();
  await page.keyboard.press('e');
  await expect(encoding).toHaveText('UTF-8');
  await expect(win.getByTestId('doc-body')).not.toContainText('日本語の見出し');
  await page.keyboard.press('e');
  await expect(encoding).toHaveText('Shift_JIS');
  await expect(win.getByTestId('doc-body').locator('h1')).toHaveText('日本語の見出し');
});

// 15.5: Home のプレビューに Markdown の先頭を描く
test('Home のプレビューに Markdown を描く', async ({ page, dew }) => {
  copyMd(dew);
  await start(page, dew);
  await current(page).getByRole('option', { name: 'md' }).click();
  await page.keyboard.press('l');
  await current(page).getByRole('option', { name: 'all.md' }).click();
  const preview = page.getByTestId('markdown-preview');
  await expect(preview.locator('h1')).toHaveText('全要素の見本');
  await expect(preview.locator('table')).toBeVisible();
});

// 基準9: ビルド結果の初期チャンクに react-markdown と katex が含まれない(15.6)
test('初期チャンクに react-markdown と katex を含めない', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'ブラウザを使わない検査なので1回だけ');
  const dist = resolve(import.meta.dirname, '../../../web/dist');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  // index.html が最初に読むスクリプトと、先読みするチャンク
  const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  expect(initial.length).toBeGreaterThan(0);
  const code = initial.map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
  // どちらのライブラリにも必ずある文字列
  expect(code).not.toContain('KaTeX parse error');
  expect(code).not.toContain('react-markdown');
  // 遅延ロードのチャンクには入っている
  const all = readdirSync(join(dist, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dist, 'assets', f), 'utf8'))
    .join('\n');
  expect(all).toContain('KaTeX parse error');
});
