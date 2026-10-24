// E2E 用のテスト部品: dew をテスト用の HOME と素材の複製で起動し、ページを開く
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

const repo = resolve(import.meta.dirname, '../../..');
// DEW_BIN でリリースビルドなど別のバイナリを試せる
const bin = process.env.DEW_BIN ?? join(repo, 'target/debug/dew');

const FIXTURES = ['h264_aac.mp4', 'mp4v.mp4', 'xvid_mp3.avi', 'image.png', 'image.jpg', 'sub', '.hidden.png', 'broken.mp4'];

export type Dew = {
  /** トークン付き URL(初回に開くと Cookie に移る) */
  url: string;
  /** --root に渡した、テスト素材の複製 */
  root: string;
  /** テスト用の HOME(~/.config/dew/config.toml を置くのに使う) */
  home: string;
  /** 同じサーバに対して dew を実行する(dew <ファイル> など) */
  run: (args: string[]) => string;
  /** `dew run <コマンド>` を前面で動かし続ける(テストの終わりに止める)。extraEnv はアプリに渡す環境変数 */
  spawnRun: (command: string[], extraEnv?: Record<string, string>) => ChildProcess;
  /** サーバを止める(dew stop) */
  stop: () => void;
  /** 止めたサーバを、最初と同じ引数で起動し直す */
  restart: () => void;
};

/** テスト用アプリ(tests/apps) */
export const appPath = (name: string) => join(repo, 'tests/apps', name);

function freePort(): Promise<number> {
  return new Promise((ok, ng) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? ok(addr.port) : ng(new Error('port'))));
    });
  });
}

/** 外部ツール(ffmpeg など)のうち見えるもの。null ならふつうの PATH。配列なら PATH をそれだけにする(何も入っていない環境の確認) */
type Options = { tools: string[] | null };

/** `tools` だけを置いた PATH 用のディレクトリ(sh・kill・nice・python3 はふつうの Linux に必ずあり、dew とテスト用アプリが使うので置く) */
function toolsPath(tools: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dew-bin-'));
  for (const t of ['sh', 'kill', 'nice', 'python3', ...tools]) {
    const real = execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(dir, t));
  }
  return dir;
}

export const test = base.extend<Options & { dew: Dew }>({
  tools: [null, { option: true }],
  dew: async ({ tools }, use, testInfo) => {
    const home = mkdtempSync(join(tmpdir(), 'dew-home-'));
    const root = mkdtempSync(join(tmpdir(), 'dew-root-'));
    // scripts/gen-fixtures.sh が作るものだけを複製する(手で置いたファイルが一覧の検査を乱さないように)
    for (const name of FIXTURES) cpSync(join(repo, 'tests/fixtures', name), join(root, name), { recursive: true });
    // 開発コンテナの DEW_PUBLIC_* などを持ち込まない
    const env = { HOME: home, PATH: tools ? toolsPath(tools) : (process.env.PATH ?? ''), DEW_PUBLIC_HOST: '127.0.0.1' };
    const port = await freePort();
    // 起動したディレクトリは Home の初期位置と録画の保存先(dew-recordings/)になるので、素材の複製の中で起動する
    const launch = () => execFileSync(bin, ['--port', String(port), '--root', root], { env, cwd: root });
    launch();
    const server = JSON.parse(readFileSync(join(home, '.cache/dew/server.json'), 'utf8'));
    const run = (args: string[]) => execFileSync(bin, args, { env, encoding: 'utf8' });
    const children: ChildProcess[] = [];
    // dew run の出力は、失敗したときに原因を追えるよう取っておく
    const runOutput: string[] = [];
    const spawnRun = (command: string[], extraEnv: Record<string, string> = {}) => {
      const child = spawn(bin, ['run', ...command], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      const tag = command.map((c) => c.split('/').pop()).join(' ');
      child.stdout?.on('data', (d: Buffer) => runOutput.push(`[${tag}] ${d}`));
      child.stderr?.on('data', (d: Buffer) => runOutput.push(`[${tag}] ${d}`));
      child.on('exit', (code) => runOutput.push(`[${tag}] exit ${code}`));
      children.push(child);
      return child;
    };
    const stop = () => execFileSync(bin, ['stop', '--force'], { env });
    await use({ url: `https://127.0.0.1:${server.port}/?token=${server.token}`, root, home, run, spawnRun, stop, restart: launch });
    for (const c of children) c.kill('SIGTERM');
    // 失敗したら、原因を追えるよう dew run の出力とサーバのログを出す
    if (testInfo.status !== testInfo.expectedStatus) {
      let log = '';
      try {
        log = readFileSync(join(home, '.cache/dew/log/server.log'), 'utf8');
      } catch {
        // ログがなくても続ける
      }
      console.log(`---- ${testInfo.title}: dew run ----\n${runOutput.join('')}\n---- server.log ----\n${log.split('\n').slice(-30).join('\n')}`);
    }
    stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  },
});
export { expect };

/** ページを開き、自動再生のための「クリックかキーで開始」を済ませる(7.6) */
export async function start(page: Page, dew: Dew) {
  await page.goto(dew.url);
  // トークンは URL から消える(予約していたファイルがすぐ開くと /canvas になるので、トークンがないことだけを見る)
  await expect(page).toHaveURL((u) => !u.searchParams.has('token'));
  // ページの準備が整う前に押すと表示が消えないので、消えるまで押し直す
  const overlay = page.getByTestId('start-overlay');
  await expect(overlay).toBeVisible();
  await expect(async () => {
    await page.keyboard.press('Shift');
    await expect(overlay).toBeHidden({ timeout: 500 });
  }).toPass();
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

/** 音声を復号しているか(Chrome は復号したバイト数、Firefox は mozHasAudio で見る) */
export async function audioDecoded(video: ReturnType<Page['locator']>) {
  return video.evaluate((v: HTMLVideoElement & { webkitAudioDecodedByteCount?: number; mozHasAudio?: boolean }) =>
    v.webkitAudioDecodedByteCount !== undefined ? v.webkitAudioDecodedByteCount > 0 : v.mozHasAudio === true,
  );
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

/** フェーズ2の素材(tests/fixtures/p2)を、閲覧範囲の起点に複製する */
export function copyP2(dew: Dew, names: string[]) {
  for (const name of names) cpSync(join(repo, 'tests/fixtures/p2', name), join(dew.root, name));
}

/** フェーズ6の素材(tests/fixtures/md)を、閲覧範囲の起点の md/ に複製する。複製先を返す */
export function copyMd(dew: Dew) {
  const dir = join(dew.root, 'md');
  cpSync(join(repo, 'tests/fixtures/md'), dir, { recursive: true });
  return dir;
}

/** フェーズ7の素材(tests/fixtures/csv)を、閲覧範囲の起点の csv/ に複製する。複製先を返す */
export function copyCsv(dew: Dew, names: string[]) {
  const dir = join(dew.root, 'csv');
  mkdirSync(dir, { recursive: true });
  for (const name of names) cpSync(join(repo, 'tests/fixtures/csv', name), join(dir, name));
  return dir;
}

/** 設定ファイル(~/.config/dew/config.toml)を書く。サーバが読むのは起動したときだけ */
export function writeConfig(dew: Dew, toml: string) {
  mkdirSync(join(dew.home, '.config/dew'), { recursive: true });
  writeFileSync(join(dew.home, '.config/dew/config.toml'), toml);
}

/** ページを読み直し、「クリックかキーで開始」を済ませる */
export async function reloadPage(page: Page) {
  await page.reload();
  const overlay = page.getByTestId('start-overlay');
  await expect(async () => {
    await page.keyboard.press('Shift');
    await expect(overlay).toBeHidden({ timeout: 500 });
  }).toPass();
}

/** 素材の1画素の値を ffmpeg で読む(8bit は rgb24、16bit は rgb48le) */
export function pixelOf(path: string, x: number, y: number, bits: 8 | 16 = 8): number[] {
  const fmt = bits === 8 ? 'rgb24' : 'rgb48le';
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', fmt, '-']);
  return bits === 8 ? [...out] : [0, 1, 2].map((i) => out.readUInt16LE(i * 2));
}

/** 複数の動画の表示中のフレーム番号を、同じ瞬間に読む(1回の evaluate で) */
export async function frameNumbersAtOnce(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLVideoElement>('[data-testid="player-window"] video, [data-testid="compare-window"] video')].map((v) => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      let n = 0;
      for (let bit = 0; bit < 20; bit++) if (ctx.getImageData(bit * 16 + 8, 8, 1, 1).data[0]! > 128) n |= 1 << bit;
      return n;
    }),
  );
}

/** ライブウィンドウ(フェーズ3)。名前はアプリのウィンドウ名 */
export function liveWindow(page: Page, title: string) {
  return page.getByTestId('live-window').and(page.getByLabel(title, { exact: true }));
}

/** ライブウィンドウの canvas から、上から row 段目の2進ブロック(16px 幅、左から bit0)を読む */
export async function liveBits(win: ReturnType<Page['locator']>, row: number, bits: number) {
  return win.locator('canvas').evaluate(
    (c: HTMLCanvasElement, [row, bits]) => {
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      let n = 0;
      for (let bit = 0; bit < bits; bit++) if (ctx.getImageData(bit * 16 + 8, row * 16 + 8, 1, 1).data[0]! > 128) n += 2 ** bit;
      return n;
    },
    [row, bits] as const,
  );
}

/** Home で Ctrl+クリックして選ぶ */
export async function pick(page: Page, names: string[]) {
  for (const name of names) await current(page).getByRole('option', { name }).click({ modifiers: ['Control'] });
}
