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

// 基準3: 直近30秒を巻き戻して再生できる
test('直近30秒を巻き戻して再生できる', async ({ page, dew }) => {
  test.setTimeout(90_000);
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0', '--fps', '30']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  const frame = () => liveBits(win, 0, 20);
  // 30秒より長く流してから、一時停止して先頭(30秒前)へ
  await page.waitForTimeout(34_000);
  await page.keyboard.press('k');
  await expect(win).toHaveAttribute('data-paused', 'true');
  const paused = await frame();
  await page.waitForTimeout(500);
  expect(await frame()).toBe(paused); // 止まっている
  await page.keyboard.press('0');
  // 30fps のアプリなので、30秒前はおよそ 900 フレーム前。位置は受け取った時刻で数えるので、負荷が高く
  // フレームがまとまって届くと少しずれる(キーフレームの区切りのぶん古いのもよい)
  await expect.poll(async () => paused - (await frame())).toBeGreaterThanOrEqual(840);
  expect(paused - (await frame())).toBeLessThanOrEqual(1100);
  // 5秒進める(l)と、およそ 150 フレーム進む
  const old = await frame();
  await page.keyboard.press('l');
  await expect.poll(async () => (await frame()) - old).toBeGreaterThanOrEqual(110);
  expect((await frame()) - old).toBeLessThanOrEqual(200);
  // 再生すると、巻き戻した位置から進む
  await page.keyboard.press('k');
  const a = await frame();
  await expect.poll(frame).toBeGreaterThan(a + 20);
  expect(await frame()).toBeLessThan(paused);
  await expect(win).toHaveAttribute('data-rewind', 'playing');
  // マウスでも: 「ライブへ戻る」で今の映像に戻り、一時停止ボタンで止められる
  await win.getByRole('button', { name: 'ライブへ戻る' }).click();
  await expect(win).toHaveAttribute('data-rewind', 'live');
  await expect.poll(frame).toBeGreaterThan(paused + 30);
  await win.locator('.live-bar').getByRole('button', { name: '一時停止' }).click();
  await expect(win).toHaveAttribute('data-paused', 'true');
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

/** MP4 の最初のフレームに焼き込まれたフレーム番号(counter.py の上端 16px の白黒ブロック) */
function firstFrameNumber(file: string) {
  const row = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'crop=320:16:0:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
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
  // 巻き戻し中: 移動のキーとライブへ戻る(G)が出る
  await page.waitForTimeout(1500);
  await page.keyboard.press('k');
  await expect(hints).toContainText('ライブへ戻る');
  await expect(hints).toContainText('±5秒');
  await page.keyboard.press('G');
  await expect(win).toHaveAttribute('data-rewind', 'live');
  await expect(hints).not.toContainText('ライブへ戻る');
  // 入力モード中は抜けるキーだけ
  await page.keyboard.press('i');
  await expect(hints).toContainText('入力モードを抜ける');
  await expect(hints).not.toContainText('録画');
});
