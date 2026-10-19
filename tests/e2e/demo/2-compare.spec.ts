// 紹介動画2: 複数のファイルをまとめて開く・比較する
import { caption, clickOn, expect, keys, moveTo, pause, start, test } from './lib';

test('2-compare', async ({ page, demo }) => {
  await start(page, demo);
  await caption(page, 'Space で複数選んで、Enter でまとめて開く');
  await keys(page, ['j', 'j', 'j', 'l'], 600);
  await keys(page, [' ', ' ', ' '], 700); // Space は選んで次へ進む
  await keys(page, ['Enter'], 3000);
  await expect(page.getByTestId('player-window')).toHaveCount(3);

  await caption(page, 'K で全部まとめて一時停止・再生');
  await keys(page, ['K'], 1500);
  await keys(page, ['K'], 1500);
  await caption(page, 'w X で全部閉じて、h で Home へ');
  await keys(page, ['w', 'X'], 900);
  await keys(page, ['h'], 1000);

  await caption(page, '比較: 2つを選んで(マウスなら Ctrl+クリック) c');
  await clickOn(page, page.getByRole('option', { name: 'results', exact: true }));
  await pause(page, 800);
  // Home が直前の場所(videos)なら、results は親のカラムにあり、クリックで中に入る。最上位にいたら l で入る
  const list = page.getByRole('listbox', { name: 'current' });
  const input = list.getByRole('option', { name: 'input.mp4', exact: true });
  if (!(await input.isVisible())) await keys(page, ['l'], 700);
  await clickOn(page, input, 0.5, 0.5, { modifiers: ['Control'] });
  await clickOn(page, list.getByRole('option', { name: 'detected.mp4', exact: true }), 0.5, 0.5, { modifiers: ['Control'] });
  await pause(page, 600);
  await keys(page, ['c'], 2500);
  const win = page.getByTestId('compare-window');
  await expect(win).toBeVisible();

  await caption(page, 'スライダー: 境目を動かして、入力と結果を見比べる');
  await clickOn(page, win.getByRole('radio', { name: 'スライダー' }));
  await pause(page, 800);
  const stage = (await win.getByTestId('compare-stage').boundingBox())!;
  const handle = (await win.getByTestId('compare-handle').boundingBox())!;
  const y = handle.y + handle.height / 2;
  await moveTo(page, handle.x + handle.width / 2, y);
  await page.mouse.down();
  for (const fx of [0.2, 0.8, 0.35, 0.65, 0.5]) {
    await moveTo(page, stage.x + stage.width * fx, y);
    await pause(page, 400);
  }
  await page.mouse.up();
  await pause(page, 800);

  await caption(page, '差分: 違うところ(書き足した枠)だけが明るく出る');
  await clickOn(page, win.getByRole('radio', { name: '差分' }));
  await pause(page, 3000);
  await caption(page, '並べる: 同じ時刻のフレームを左右に並べて再生');
  await clickOn(page, win.getByRole('radio', { name: '並べる' }));
  await pause(page, 3000);
  await caption(page, '');
  await pause(page, 400);
});
