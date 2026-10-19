// 紹介動画の部品: 素材のディレクトリで dew を起動し、マウスの位置・押したキー・説明の字幕を画面に重ねる
// (Playwright の録画にはマウスカーソルが映らず、キー操作も見えないため)
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

const repo = resolve(import.meta.dirname, '../../..');
const bin = process.env.DEW_BIN ?? join(repo, 'target/debug/dew');
/** scripts/demo/make-media.sh で作った素材(record.sh が渡す) */
const media = process.env.DEW_DEMO_MEDIA ?? '';

export type Demo = {
  root: string;
  url: string;
  /** `dew run <コマンド>` をバックグラウンドで動かす(終わりに止める) */
  spawnRun: (command: string[]) => ChildProcess;
};

/** 画面に重ねる表示(カーソル、クリックの波紋、押したキー、字幕) */
function overlayScript() {
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px;
        left: -40px; top: -40px; transform: translate(-3px, -2px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
      .demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px;
        border-radius: 50%; border: 3px solid rgba(255, 200, 0, .95); animation: demo-ripple .5s ease-out forwards; }
      @keyframes demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
      #demo-keys { position: fixed; z-index: 2147483647; pointer-events: none; left: 50%; transform: translateX(-50%); bottom: 170px; display: flex; gap: 6px; }
      .demo-key { font: 600 22px/1 "Noto Sans Mono CJK JP", monospace; color: #fff; background: rgba(20,20,20,.82);
        border: 1px solid rgba(255,255,255,.35); border-radius: 8px; padding: 8px 12px; transition: opacity .4s; }
      #demo-caption { position: fixed; z-index: 2147483647; pointer-events: none; left: 50%; bottom: 112px; transform: translateX(-50%);
        font: 600 22px/1.4 "Noto Sans CJK JP", sans-serif; color: #fff; background: rgba(15,15,15,.85); border-radius: 10px;
        padding: 8px 18px; white-space: nowrap; transition: opacity .3s; opacity: 0; }`;
    document.head.append(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = `<svg viewBox="0 0 22 22" width="22" height="22"><path d="M2 1 L2 18 L6.5 13.8 L9.6 20.5 L12.6 19.2 L9.6 12.6 L15.5 12.6 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const keys = document.createElement('div');
    keys.id = 'demo-keys';
    const caption = document.createElement('div');
    caption.id = 'demo-caption';
    document.body.append(cursor, keys, caption);
    addEventListener('mousemove', (e) => {
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.body.append(r);
      setTimeout(() => r.remove(), 600);
    }, true);
    const names: Record<string, string> = { ' ': 'Space', ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc' };
    addEventListener('keydown', (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      const label = (e.ctrlKey ? 'Ctrl+' : '') + (names[e.key] ?? e.key);
      const k = document.createElement('div');
      k.className = 'demo-key';
      k.textContent = label;
      keys.append(k);
      while (keys.children.length > 6) keys.firstElementChild!.remove();
      setTimeout(() => (k.style.opacity = '0'), 1200);
      setTimeout(() => k.remove(), 1700);
    }, true);
  };
  if (document.body) install();
  else addEventListener('DOMContentLoaded', install);
}

export const test = base.extend<{ demo: Demo }>({
  demo: async ({ page }, use) => {
    if (!media) throw new Error('DEW_DEMO_MEDIA に素材のディレクトリを指定してください(scripts/demo/record.sh)');
    const home = mkdtempSync(join(tmpdir(), 'dew-demo-home-'));
    const root = media;
    const env = { ...process.env, HOME: home, DEW_PUBLIC_HOST: '127.0.0.1' };
    delete (env as Record<string, string | undefined>).DEW_PUBLIC_PORT;
    execFileSync(bin, ['--port', '18800', '--root', root], { env, cwd: root });
    const server = JSON.parse(readFileSync(join(home, '.cache/dew/server.json'), 'utf8'));
    const children: ChildProcess[] = [];
    const spawnRun = (command: string[]) => {
      const child = spawn(bin, ['run', ...command], { env, cwd: root, stdio: 'ignore' });
      children.push(child);
      return child;
    };
    await page.addInitScript(overlayScript);
    await use({ root, url: `https://127.0.0.1:${server.port}/?token=${server.token}`, spawnRun });
    for (const c of children) c.kill('SIGTERM');
    execFileSync(bin, ['stop'], { env });
    rmSync(home, { recursive: true, force: true });
  },
});
export { expect };

/** 人が操作しているように見える間 */
export const pause = (page: Page, ms = 700) => page.waitForTimeout(ms);

/** 字幕を出す(空文字で消す) */
export async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    const c = document.getElementById('demo-caption')!;
    if (t) c.textContent = t;
    c.style.opacity = t ? '1' : '0';
  }, text);
}

let last = { x: 640, y: 360 };
/** マウスを滑らかに動かす */
export async function moveTo(page: Page, x: number, y: number) {
  const d = Math.hypot(x - last.x, y - last.y);
  await page.mouse.move(x, y, { steps: Math.max(8, Math.round(d / 18)) });
  last = { x, y };
}

/** 要素の中の相対位置へマウスを動かしてクリックする */
export async function clickOn(page: Page, el: Locator, fx = 0.5, fy = 0.5, opts: { modifiers?: 'Control'[] } = {}) {
  const b = (await el.boundingBox())!;
  await moveTo(page, b.x + b.width * fx, b.y + b.height * fy);
  await pause(page, 250);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.up();
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
  await pause(page, 300);
}

/** キーを人の速さで押す */
export async function keys(page: Page, seq: string[], gap = 450) {
  for (const k of seq) {
    await page.keyboard.press(k);
    await pause(page, gap);
  }
}

/** ページを開き、「クリックかキーで開始」をクリックで済ませる */
export async function start(page: Page, demo: Demo) {
  await page.goto(demo.url);
  const overlay = page.getByTestId('start-overlay');
  await expect(overlay).toBeVisible();
  await pause(page, 1000);
  await expect(async () => {
    await clickOn(page, overlay);
    await expect(overlay).toBeHidden({ timeout: 500 });
  }).toPass();
}

/**
 * 端末の様子を画面の左下に出し、コマンドを1文字ずつ打つ(録画は画面だけで、端末は映らないため)。
 * 実際のコマンドは、呼んだ側が dew run などで動かす
 */
export async function terminal(page: Page, command: string) {
  await page.evaluate(() => {
    if (document.getElementById('demo-term')) return;
    const t = document.createElement('div');
    t.id = 'demo-term';
    t.style.cssText = `position: fixed; z-index: 2147483645; pointer-events: none; left: 16px; bottom: 44px; width: 560px;
      background: rgba(18,18,22,.94); color: #e6e6e6; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.5);
      font: 15px/1.5 "Noto Sans Mono CJK JP", monospace; overflow: hidden;`;
    t.innerHTML = `<div style="background:#2b2b33;padding:4px 12px;font-size:13px;color:#aaa">端末(コンテナの中。画面・WSLg なし)</div><div id="demo-term-body" style="padding:8px 12px;min-height:3em"></div>`;
    document.body.append(t);
  });
  await page.evaluate(() => {
    const body = document.getElementById('demo-term-body')!;
    const line = document.createElement('div');
    line.innerHTML = '<span style="color:#7fd17f">dev@container</span>:<span style="color:#7fa7ff">~/my-project</span>$ <span class="cmd"></span>';
    body.append(line);
    while (body.children.length > 4) body.firstElementChild!.remove();
  });
  for (const ch of command) {
    await page.evaluate((c) => {
      const cmds = document.querySelectorAll('#demo-term-body .cmd');
      cmds[cmds.length - 1]!.textContent += c;
    }, ch);
    await page.waitForTimeout(55);
  }
  await pause(page, 500);
}

/** 端末の様子を消す */
export async function hideTerminal(page: Page) {
  await page.evaluate(() => document.getElementById('demo-term')?.remove());
}
