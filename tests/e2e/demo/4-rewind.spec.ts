// 紹介動画4: 映したウィンドウの録画と巻き戻し
import { caption, clickOn, expect, hideTerminal, keys, pause, start, terminal, test } from './lib';

const APPEAR = { timeout: 30_000 };

test('4-rewind', async ({ page, demo }) => {
  await start(page, demo);
  await terminal(page, 'dew run python3 src/balls.py');
  demo.spawnRun(['python3', 'src/balls.py']);
  const win = page.getByTestId('live-window').and(page.getByLabel('balls', { exact: true }));
  await expect(win).toBeVisible(APPEAR);
  await hideTerminal(page);
  await pause(page, 1500);

  await caption(page, 'R で録画(録画中は枠が赤くなる)');
  await keys(page, ['R'], 1200);
  await expect(win).toHaveAttribute('data-recording', 'true');
  await keys(page, ['i'], 500);
  const canvas = win.locator('canvas');
  for (const [fx, fy] of [[0.25, 0.3], [0.5, 0.2], [0.75, 0.35], [0.4, 0.25], [0.6, 0.3]] as const) {
    await clickOn(page, canvas, fx, fy);
    await pause(page, 500);
  }
  await keys(page, ['Control+BracketLeft'], 500);
  await caption(page, 'もう一度 R で止めると、dew-recordings/ に MP4 で保存');
  await keys(page, ['R'], 2500);
  await expect(win).toHaveAttribute('data-recording', 'false');

  await caption(page, 'k で一時停止すると、直近 30 秒を巻き戻して見られる');
  await keys(page, ['k'], 1500);
  await caption(page, 'j で 5 秒戻る、, と . でコマ送り');
  await keys(page, ['j'], 1500);
  await keys(page, ['j'], 1500);
  await keys(page, ['.', '.', '.', ','], 600);
  await caption(page, 'k で、巻き戻した位置から再生');
  await keys(page, ['k'], 3000);
  await caption(page, 'q でライブに戻る');
  await keys(page, ['q'], 2000);
  await expect(win).toHaveAttribute('data-rewind', 'live');

  await caption(page, '録画したファイルは、Home からそのまま開ける');
  await keys(page, ['h'], 1000);
  await clickOn(page, page.getByRole('option', { name: /^dew-recordings/ }));
  await keys(page, ['l'], 800);
  await keys(page, ['Enter'], 4000);
  await caption(page, '');
  await pause(page, 400);
});
