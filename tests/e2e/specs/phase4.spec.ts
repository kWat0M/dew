// フェーズ4の受け入れ基準(docs/spec.md 11章): 精度モード、録画、巻き戻し。NVENC の切り替えは Rust のテスト(crates/capture)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPath, expect, liveBits, liveWindow, start, test } from '../lib/dew';

test.describe.configure({ timeout: 60_000 });
const APPEAR = { timeout: 20_000 };

// 基準1: 精度モードの cv2.imshow で、受信フレームが送信元の配列と画素単位で一致する
test.fixme('精度モードの cv2.imshow が画素単位で一致する', async ({ page, dew }) => {
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
test.fixme('録画した MP4 の長さが録画時間と ±1秒以内', async ({ page, dew }) => {
  await start(page, dew);
  dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
  const win = liveWindow(page, 'counter');
  await expect(win).toBeVisible(APPEAR);
  await page.waitForTimeout(3000);
  await page.keyboard.press('R');
  await expect(win).toHaveAttribute('data-recording', 'true');
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
  expect(Math.abs(Number(probe.format.duration) - seconds)).toBeLessThanOrEqual(1);
  // 最後まで復号できる(壊れていない)
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
});

// 基準3: 直近30秒を巻き戻して再生できる
test.fixme('直近30秒を巻き戻して再生できる', async ({ page, dew }) => {
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
  // 30fps のアプリなので、30秒前は 900 フレーム前(キーフレームの区切りのぶん少し古くてもよい)
  await expect.poll(async () => paused - (await frame())).toBeGreaterThanOrEqual(870);
  expect(paused - (await frame())).toBeLessThanOrEqual(1000);
  // 5秒進める(l)と 150 フレーム進む
  const old = await frame();
  await page.keyboard.press('l');
  await expect.poll(async () => (await frame()) - old).toBeGreaterThanOrEqual(140);
  expect((await frame()) - old).toBeLessThanOrEqual(160);
  // 再生すると、巻き戻した位置から進む
  await page.keyboard.press('k');
  const a = await frame();
  await expect.poll(frame).toBeGreaterThan(a + 20);
  expect(await frame()).toBeLessThan(paused);
});
