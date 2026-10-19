// 紹介動画3: プログラムを書き換えずに、GUI のウィンドウをブラウザに映す(dew run / dew env)
import { caption, clickOn, expect, hideTerminal, keys, pause, start, terminal, test } from './lib';

const APPEAR = { timeout: 30_000 };

test('3-live', async ({ page, demo }) => {
  await start(page, demo);
  await caption(page, 'GUI のプログラムを、書き換えずにブラウザへ映す');
  await pause(page, 1500);
  await terminal(page, 'dew run python3 src/balls.py');
  demo.spawnRun(['python3', 'src/balls.py']);
  const balls = page.getByTestId('live-window').and(page.getByLabel('balls', { exact: true }));
  await expect(balls).toBeVisible(APPEAR);
  await caption(page, 'cv2.imshow のウィンドウ。WSLg も X サーバも要らない');
  await pause(page, 3000);
  await hideTerminal(page);

  await caption(page, 'i で入力モード: キーとマウスがアプリに届く');
  await keys(page, ['i'], 800);
  const canvas = balls.locator('canvas');
  for (const [fx, fy] of [[0.3, 0.3], [0.6, 0.25], [0.8, 0.4], [0.45, 0.2]] as const) {
    await clickOn(page, canvas, fx, fy);
    await pause(page, 500);
  }
  await caption(page, 'キーも届く(このアプリは g で重力を切り替える)');
  await keys(page, ['g'], 2500);
  await keys(page, ['g'], 1500);
  await caption(page, 'Ctrl+] で入力モードを抜ける');
  await keys(page, ['Control+BracketRight'], 1500);

  await caption(page, 'eval "$(dew env)" のあとは、ふつうに起動するだけで映る');
  await terminal(page, 'eval "$(dew env)"');
  await terminal(page, 'python3 src/plot.py');
  demo.spawnRun(['python3', 'src/plot.py']);
  await expect(page.getByTestId('live-window').and(page.getByLabel('training', { exact: true }))).toBeVisible(APPEAR);
  await caption(page, 'matplotlib のウィンドウも、そのまま並んで映る');
  await pause(page, 2000);
  await hideTerminal(page);
  await pause(page, 3000);
  await caption(page, '');
  await pause(page, 400);
});
