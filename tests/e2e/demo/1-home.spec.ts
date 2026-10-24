// 紹介動画1: Home の画面と、キー(vim 風)・マウスの両方でファイルを開く操作
import { caption, clickOn, expect, keys, moveTo, pause, start, test } from './lib';

test('1-home', async ({ page, demo }) => {
  await start(page, demo);
  await caption(page, 'dew を起動したディレクトリのファイルが並ぶ(Home)');
  await pause(page, 2500);

  await caption(page, 'j / k で上下、l で中へ、h で親へ(vim と同じキー)');
  await keys(page, ['j', 'j', 'j', 'l'], 700);
  await caption(page, '選んだファイルは右にプレビューと情報が出る');
  await keys(page, ['j', 'j', 'k'], 1100);
  await caption(page, 'v でサムネイルの一覧に切り替え');
  await keys(page, ['v'], 2200);
  await keys(page, ['v'], 600);

  await caption(page, 'Enter で開くと、音声付き・元のフレームレートで再生');
  await keys(page, ['Enter'], 2500);
  await caption(page, '開いた直後は操作モード: l / j で 5 秒送り・戻し、k で一時停止、. と , でコマ送り');
  await keys(page, ['l', 'l', 'j'], 900);
  await keys(page, ['k'], 700);
  await keys(page, ['.', '.', '.', ','], 500);
  await keys(page, ['k'], 1500);

  await caption(page, 'Tab で Home に戻る');
  await keys(page, ['Tab'], 1500);

  await caption(page, 'マウスでも同じことができる(クリックで選択、ダブルクリックで開く)');
  await clickOn(page, page.getByRole('option', { name: 'images', exact: true }));
  await pause(page, 600);
  const input = page.getByRole('option', { name: 'input.png', exact: true });
  await clickOn(page, input);
  await pause(page, 1200);
  await input.dblclick();
  await pause(page, 1500);
  const win = page.getByRole('region', { name: 'input.png' });
  await expect(win.locator('img')).toBeVisible();

  await caption(page, '画像は等倍にして、カーソルの下の画素の値を見られる');
  await clickOn(page, win.getByRole('button', { name: '等倍', exact: true }));
  await pause(page, 800);
  const img = win.locator('img');
  const box = (await img.boundingBox())!;
  for (const [fx, fy] of [[0.45, 0.4], [0.55, 0.5], [0.62, 0.45]] as const) {
    await moveTo(page, box.x + box.width * fx, box.y + box.height * fy);
    await pause(page, 900);
  }
  await expect(win.getByTestId('pixel-info')).toBeVisible();

  await caption(page, '? でキーの一覧。右上の操作パネルからは、全部の操作をマウスで行える');
  await keys(page, ['?'], 2500);
  await keys(page, ['Escape'], 800);
  // キー一覧が閉じきる前のクリックは閉じる操作になるので、パネルが出るまで押し直す
  await expect(async () => {
    await clickOn(page, page.getByRole('button', { name: '操作パネル', exact: true }));
    await expect(page.getByTestId('ops-panel')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await pause(page, 3000);
  await caption(page, '');
  await pause(page, 500);
});
