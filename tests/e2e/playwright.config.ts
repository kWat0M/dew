import { defineConfig } from '@playwright/test';

// Chrome: 同梱の Chromium は H.264 / AAC を再生できないため、インストール済みの Google Chrome を使う。
// Firefox: Zen など Firefox 系への対応を確かめる(playwright install firefox で入れる)
// 時間に厳しいテストは、ほかと CPU を取り合うと揺らぐので、ほかがすべて終わってから流す(ADR 0011)
//   perf: 性能の基準(1080p 60fps)。Chrome で1つだけ
//   timing-*: 同期再生・巻き戻しの位置。perf の後に Chrome と Firefox で
const perf = /phase3-perf\.spec\.ts$/;
const timing = /timing-perf\.spec\.ts$/;
const chrome = { browserName: 'chromium', channel: 'chrome' } as const;
const firefox = { browserName: 'firefox' } as const;
export default defineConfig({
  testDir: './specs',
  // ブラウザの音の出し先(Firefox の音のテスト用。ADR 0027)
  globalSetup: './lib/browser-audio.ts',
  use: { headless: true, ignoreHTTPSErrors: true },
  projects: [
    { name: 'chrome', testIgnore: [perf, timing], use: chrome },
    { name: 'firefox', testIgnore: [perf, timing], use: firefox },
    { name: 'perf', testMatch: perf, dependencies: ['chrome', 'firefox'], use: chrome },
    { name: 'timing-chrome', testMatch: timing, dependencies: ['perf'], use: chrome },
    { name: 'timing-firefox', testMatch: timing, dependencies: ['perf'], use: firefox },
  ],
});
