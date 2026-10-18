// フェーズ4の受け入れ基準(docs/spec.md 11章): 精度モード、録画、巻き戻し。NVENC の切り替えは Rust のテスト(crates/capture)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPath, expect, liveBits, liveWindow, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });
const APPEAR = { timeout: 20_000 };

// 基準1: 精度モードの cv2.imshow で、受信フレームが送信元の配列と画素単位で一致する
test('精度モードの cv2.imshow が画素単位で一致する', async ({ page, dew }) => {
  const frame = join(mkdtempSync(join(tmpdir(), 'dew-frame-')), 'frame.rgb');
  await start(page, dew);
  dew.spawnRun(['--exact', 'python3', appPath('exact_sample.py')], { DEW_TEST_FRAME: frame });
  const win = liveWindow(page, 'exact');
  await expect(win).toBeVisible(APPEAR);
  // 精度モードの窓は X の窓としては出ない(キャプチャの映像と二重にならない)
  await expect(page.getByTestId('live-window')).toHaveCount(1);
  await expect(win).toHaveAttribute('data-exact', 'true');
  await expect.poll(() => win.evaluate((el) => Number(el.getAttribute('data-decoded'))), APPEAR).toBeGreaterThan(0);
  const want = readFileSync(frame).toString('base64');
  const mismatch = await win.locator('canvas').evaluate((c: HTMLCanvasElement, b64: string) => {
    const want = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    if (c.width !== 320 || c.height !== 240) return `大きさが違う: ${c.width}x${c.height}`;
    const got = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0, j = 0; j < want.length; i += 4, j += 3) {
      if (got[i] !== want[j] || got[i + 1] !== want[j + 1] || got[i + 2] !== want[j + 2]) return `画素 ${j / 3} が違う`;
    }
    return '';
  }, want);
  expect(mismatch).toBe('');
});

// 基準2: 録画した MP4 が再生でき、長さが録画時間と ±1秒以内
test('録画した MP4 の長さが録画時間と ±1秒以内', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.waitForTimeout(3000);
  await page.keyboard.press('R');
  await expect(win).toHaveAttribute('data-recording', 'true');
  // 録画中は枠が赤い
  await expect(win).toHaveClass(/\brecording\b/);
  const t0 = Date.now();
  await page.waitForTimeout(5000);
  await page.keyboard.press('R');
  const seconds = (Date.now() - t0) / 1000;
  await expect(win).toHaveAttribute('data-recording', 'false');
  // 保存先は最初に dew を起動したディレクトリの dew-recordings/(9.1)
  const dir = join(dew.root, 'dew-recordings');
  await expect.poll(() => readdirSync(dir).filter((f) => f.endsWith('.mp4')).length, { timeout: 10_000 }).toBe(1);
  const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.mp4'))!);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', file], { encoding: 'utf8' }));
  expect(probe.streams[0].codec_name).toBe('h264');
  console.log(`録画の長さ ${Number(probe.format.duration).toFixed(2)} 秒、録画時間 ${seconds.toFixed(2)} 秒`);
  expect(Math.abs(Number(probe.format.duration) - seconds)).toBeLessThanOrEqual(1);
  // 最後まで復号できる(壊れていない)
  // 一時停止中の止まった画や、シークで追いつくフレーム(1 ms 間隔)があるので、時刻はそのまま µs で扱わせる
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-enc_time_base:v', '1/1000000', '-fps_mode', 'passthrough', '-f', 'null', '-']);
});


// L3: 精度モードでも、入力モードで押したキーが waitKey に返る(Esc で終わるふつうのループが動く)
test('精度モードの waitKey に入力モードのキーが届く', async ({ page, dew }) => {
  const keylog = join(mkdtempSync(join(tmpdir(), 'dew-keys-')), 'keys.txt');
  writeFileSync(keylog, '');
  await start(page, dew);
  const child = dew.spawnRun(['--exact', 'python3', appPath('exact_sample.py')], { DEW_TEST_KEYLOG: keylog });
  const win = liveWindow(page, 'exact');
  await expect(win).toBeVisible(APPEAR);
  await page.keyboard.press('i');
  await expect(win).toHaveAttribute('data-input', 'true');
  await page.keyboard.type('q');
  await expect.poll(() => readFileSync(keylog, 'utf8').split('\n').filter(Boolean), { timeout: 10_000 }).toEqual(['113']);
  await page.keyboard.press('Escape');
  await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(0);
  // アプリが終わると「終了」になる
  await expect(win.locator('.live-bar')).toContainText('終了');
});

/** MP4 の最初(last なら最後のあたり)のフレームに焼き込まれたフレーム番号(counter.py の上端 16px の白黒ブロック) */
function firstFrameNumber(file: string, last = false) {
  const from = last ? ['-sseof', '-0.3'] : [];
  const row = execFileSync('ffmpeg', ['-v', 'error', ...from, '-i', file, '-frames:v', '1', '-vf', 'crop=320:16:0:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  let n = 0;
  for (let bit = 0; bit < 20; bit++) if (row[8 * 320 + bit * 16 + 8]! > 128) n += 2 ** bit;
  return n;
}

// L7: 巻き戻して再生しているときに録画すると、ライブではなく、表示している巻き戻しの映像が録れる
test('巻き戻し中の録画は表示している映像を録る', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0', '--fps', '30']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  const frame = () => liveBits(win, 0, 20);
  await page.waitForTimeout(8000);
  const live = await frame();
  await page.keyboard.press('k');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(win).toHaveAttribute('data-rewind', 'playing');
  // 復号し直した巻き戻しの映像が描かれるまで待つ(5 秒 = 150 フレーム前)
  await expect.poll(frame).toBeLessThan(live - 100);
  const shown = await frame();
  await page.keyboard.press('R');
  await expect(win).toHaveAttribute('data-recording', 'true');
  await page.waitForTimeout(3000);
  await page.keyboard.press('R');
  await expect(win).toHaveAttribute('data-recording', 'false');
  const dir = join(dew.root, 'dew-recordings');
  await expect.poll(() => readdirSync(dir).filter((f) => f.endsWith('.mp4')).length, { timeout: 10_000 }).toBe(1);
  const first = firstFrameNumber(join(dir, readdirSync(dir).find((f) => f.endsWith('.mp4'))!));
  // 録画の最初は、押したときに表示していたあたり(直前のキーフレームは 1 秒 = 30 フレーム以内)。ライブ(5 秒先)ではない
  expect(first).toBeGreaterThanOrEqual(shown - 45);
  expect(first).toBeLessThanOrEqual(shown + 30);
});

// 4.4: ヒントの帯は、フォーカス中のウィンドウの種類と状態(録画中・巻き戻し中)で変わる
test('ヒントの帯がライブウィンドウの状態に合わせて変わる', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  // Home のヒントの帯も DOM には残っているので、見えている方を使う
  const hints = page.locator('[data-testid="hint-bar"]:visible');
  // ライブ: 録画・入力モードがあり、動画の速度([ ])はない。キャンバス共通(w)はいつも出る
  await expect(hints).toContainText('録画');
  await expect(hints).toContainText('入力モード');
  await expect(hints).toContainText('ウィンドウ操作');
  await expect(hints).not.toContainText('速度');
  await expect(hints).not.toContainText('ライブへ戻る');
  await page.keyboard.press('R');
  await expect(hints).toContainText('録画を止める');
  await page.keyboard.press('R');
  await expect(hints).not.toContainText('録画を止める');
  // 巻き戻し中: 移動のキーとライブへ戻る(q)が出る
  await page.waitForTimeout(1500);
  await page.keyboard.press('k');
  await expect(hints).toContainText('ライブへ戻る');
  await expect(hints).toContainText('±5秒');
  await page.keyboard.press('q');
  await expect(win).toHaveAttribute('data-rewind', 'live');
  await expect(hints).not.toContainText('ライブへ戻る');
  // 入力モード中は抜けるキーだけ
  await page.keyboard.press('i');
  await expect(hints).toContainText('入力モードを抜ける');
  await expect(hints).not.toContainText('録画');
});

// 複数のアプリを同時に動かしたとき: 録画・巻き戻しはウィンドウごとで、ほかのウィンドウのライブ表示や録画に響かない
test('複数のライブウィンドウで録画と巻き戻しがそれぞれに効く', async ({ page, dew }) => {
  test.setTimeout(90_000);
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0', '--fps', '30', '--title', 'a']);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0', '--fps', '30', '--title', 'b']);
  const a = liveWindow(page, 'a');
  const b = liveWindow(page, 'b');
  await expect(a).toBeVisible(APPEAR);
  await expect(b).toBeVisible(APPEAR);
  const frame = (w: typeof a) => liveBits(w, 0, 20);
  const advancing = async (w: typeof a) => {
    const f = await frame(w);
    await expect.poll(() => frame(w)).toBeGreaterThan(f + 10);
  };
  await page.waitForTimeout(8000);

  // a を録画しても、a・b とも画面は進む
  await a.click();
  await page.keyboard.press('R');
  await expect(a).toHaveAttribute('data-recording', 'true');
  await expect(b).toHaveAttribute('data-recording', 'false');
  await advancing(a);
  await advancing(b);

  // a を巻き戻して再生する。b はライブのまま進む
  const aLive = await frame(a);
  await page.keyboard.press('k');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(a).toHaveAttribute('data-rewind', 'playing');
  await expect.poll(() => frame(a)).toBeLessThan(aLive - 100);
  await expect(b).toHaveAttribute('data-rewind', 'live');
  await advancing(b);

  // a を巻き戻したまま b を録画する。b の録画は b のライブ
  await b.click();
  const bAtStart = await frame(b);
  await page.keyboard.press('R');
  await expect(b).toHaveAttribute('data-recording', 'true');
  await page.waitForTimeout(2000);
  await page.keyboard.press('R');
  await expect(b).toHaveAttribute('data-recording', 'false');
  await a.click();
  const aShown = await frame(a);
  const aLiveNow = aShown + 150; // 巻き戻しは 5 秒(150 フレーム)遅れ
  await page.keyboard.press('R');
  await expect(a).toHaveAttribute('data-recording', 'false');

  const dir = join(dew.root, 'dew-recordings');
  await expect.poll(() => readdirSync(dir).filter((f) => f.endsWith('.mp4')).length, { timeout: 10_000 }).toBe(2);
  const fileOf = (title: string) => join(dir, readdirSync(dir).find((f) => f.startsWith(`${title}-`))!);
  const bFirst = firstFrameNumber(fileOf('b'));
  expect(Math.abs(bFirst - bAtStart)).toBeLessThanOrEqual(45);
  // a の録画の終わりは、巻き戻した映像(ライブより 5 秒前)
  const aLast = firstFrameNumber(fileOf('a'), true);
  expect(Math.abs(aLast - aShown)).toBeLessThanOrEqual(45);
  expect(aLast).toBeLessThan(aLiveNow - 100);
});

// 7.9: 精度モードの窓も閉じるボタンで閉じられる。閉じたことを確かめずに imshow を続けるアプリでも、出し直さない
test('精度モードの窓を閉じるボタンで閉じられる', async ({ page, dew }) => {
  await start(page, dew);
  const child = dew.spawnRun(['--exact', 'python3', appPath('exact_sample.py')]);
  const win = liveWindow(page, 'exact');
  await expect(win).toBeVisible(APPEAR);
  await win.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(win).toHaveCount(0);
  // アプリは描き続けているが、窓は戻ってこない
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('live-window')).toHaveCount(0);
  expect(child.exitCode).toBeNull();
});

// 精度モードのアプリは、dew のサーバが止まったら(dew stop)、長いエラーを出さずに1行だけ出して終わる
test('精度モードのアプリは dew stop で1行だけ出して終わる', async ({ page, dew }) => {
  await start(page, dew);
  const child = dew.spawnRun(['--exact', 'python3', appPath('exact_sample.py')]);
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  await expect(liveWindow(page, 'exact')).toBeVisible(APPEAR);
  dew.run(['stop']);
  await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(1);
  expect(stderr).toContain('dew: dew のサーバが止まったので終了します');
  expect(stderr).not.toContain('Traceback');
});
