// 外部のツールが足りない環境: ツールの要らない機能(閲覧・ブラウザで再生できる形式の再生)は動き、
// 使えない機能は、その場所で何が足りないかを知らせる(7.10、ADR 0019)
import { appPath, current, expect, liveWindow, open, start, test } from '../lib/dew';

test.describe('ffmpeg も ffprobe もない', () => {
  test.use({ tools: [] });

  test('閲覧と再生はでき、情報の欄で ffprobe がないことを知らせる', async ({ page, dew }) => {
    await start(page, dew);
    await expect(current(page).getByRole('option', { name: 'h264_aac.mp4' })).toBeVisible();
    // プレビューの情報の欄に、足りないツールと入れ方
    await current(page).getByRole('option', { name: 'h264_aac.mp4' }).click();
    await expect(page.getByTestId('col-preview').getByTestId('tool-missing').first()).toContainText('ffprobe');
    await expect(page.getByTestId('col-preview')).toContainText('sudo apt-get install -y ffmpeg');

    // MP4 はブラウザがそのまま再生する。フレーム番号の欄に、ffprobe がないことを出す
    const video = await open(page, 'h264_aac.mp4');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);
    const win = page.getByTestId('player-window').filter({ hasText: 'h264_aac.mp4' });
    await expect(win.getByTestId('tool-missing')).toContainText('ffprobe');
    // 長さはブラウザから取る(シークバーが使える)
    await expect(win.locator('.time')).not.toContainText('/ 0:00');
  });

  test('画像はそのまま表示し、変換が要る形式は理由と入れ方を出す', async ({ page, dew }) => {
    await start(page, dew);
    await open(page, 'image.png').catch(() => {});
    const img = page.getByTestId('player-window').filter({ hasText: 'image.png' }).locator('img');
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth && i.getBoundingClientRect().width)).toBeGreaterThan(0);
    await page.keyboard.press('Tab');
    // mp4v はブラウザで再生できない。変換には ffmpeg が要ると出す
    await current(page).getByRole('option', { name: 'mp4v.mp4' }).click();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('player-window').filter({ hasText: 'mp4v.mp4' })).toContainText('ffmpeg', { timeout: 10_000 });
  });

  test('dew run は足りないものと入れ方を出して止まる', async ({ page, dew }) => {
    await start(page, dew);
    const child = dew.spawnRun(['python3', appPath('counter.py')]);
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(1);
    expect(err).toContain('sudo apt-get install -y xvfb ffmpeg');
  });
});

test.describe('pulseaudio だけがない', () => {
  test.use({ tools: ['ffmpeg', 'ffprobe', 'Xvfb', 'xkbcomp'] });

  test('dew run は音なしで映し、音が出ないことを知らせる', async ({ page, dew }) => {
    await start(page, dew);
    const child = dew.spawnRun(['python3', appPath('counter.py'), '--tone', '0']);
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    await expect(liveWindow(page, 'counter')).toBeVisible({ timeout: 20_000 });
    expect(err).toContain('pulseaudio がないので、アプリの音は出ません');
  });
});
