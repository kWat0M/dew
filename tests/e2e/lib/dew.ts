// E2E 用のテスト部品: dew をテスト用の HOME と素材の複製で起動し、ページを開く
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

const repo = resolve(import.meta.dirname, '../../..');
const bin = join(repo, 'target/debug/dew');

export type Dew = {
  /** トークン付き URL(初回に開くと Cookie に移る) */
  url: string;
  /** --root に渡した、テスト素材の複製 */
  root: string;
};

function freePort(): Promise<number> {
  return new Promise((ok, ng) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? ok(addr.port) : ng(new Error('port'))));
    });
  });
}

export const test = base.extend<{ dew: Dew }>({
  dew: async ({}, use) => {
    const home = mkdtempSync(join(tmpdir(), 'dew-home-'));
    const root = mkdtempSync(join(tmpdir(), 'dew-root-'));
    cpSync(join(repo, 'tests/fixtures'), root, { recursive: true });
    // 開発コンテナの DEW_PUBLIC_* などを持ち込まない
    const env = { HOME: home, PATH: process.env.PATH ?? '', DEW_PUBLIC_HOST: '127.0.0.1' };
    const port = await freePort();
    execFileSync(bin, ['--port', String(port), '--root', root], { env });
    const server = JSON.parse(readFileSync(join(home, '.cache/dew/server.json'), 'utf8'));
    await use({ url: `https://127.0.0.1:${server.port}/?token=${server.token}`, root });
    execFileSync(bin, ['stop'], { env });
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  },
});
export { expect };

/** ページを開き、自動再生のための「クリックかキーで開始」を済ませる(7.6) */
export async function start(page: Page, dew: Dew) {
  await page.goto(dew.url);
  await expect(page).toHaveURL(/\/$/); // トークンは URL から消える
  await page.keyboard.press('Shift');
  await expect(page.getByTestId('start-overlay')).toBeHidden();
}

/** Home の中央カラム */
export function current(page: Page) {
  return page.getByTestId('col-current');
}

/** Home の中央カラムで、選択中の項目名 */
export async function selected(page: Page) {
  return current(page).getByRole('option', { selected: true }).getAttribute('data-name');
}

/** Home でファイルを選び Enter で開く。キャンバスに出たプレイヤーの video を返す */
export async function open(page: Page, name: string) {
  await current(page).getByRole('option', { name }).click();
  await page.keyboard.press('Enter');
  const win = page.getByTestId('player-window').filter({ hasText: name });
  await expect(win).toBeVisible();
  return win.locator('video');
}

/**
 * 表示中のフレーム番号を画素から読む。素材の上端 16px に、番号を左から bit0 の
 * 16px 幅の白黒ブロックで焼き込んである(scripts/gen-fixtures.sh)
 */
export async function frameNumber(page: Page, video: ReturnType<Page['locator']>) {
  return video.evaluate((v: HTMLVideoElement) => {
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0);
    let n = 0;
    for (let bit = 0; bit < 20; bit++) {
      const [lum] = ctx.getImageData(bit * 16 + 8, 8, 1, 1).data;
      if (lum > 128) n |= 1 << bit;
    }
    return n;
  });
}
