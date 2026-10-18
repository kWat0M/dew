import { defineConfig } from '@playwright/test';

// Chrome: 同梱の Chromium は H.264 / AAC を再生できないため、インストール済みの Google Chrome を使う。
// Firefox: Zen など Firefox 系への対応を確かめる(playwright install firefox で入れる)
// perf: 性能の基準(1080p 60fps)は CPU を取り合うと測れないので、ほかがすべて終わってから Chrome で1つだけ流す
const perf = /-perf\.spec\.ts$/;
export default defineConfig({
  testDir: './specs',
  use: { headless: true, ignoreHTTPSErrors: true },
  projects: [
    { name: 'chrome', testIgnore: perf, use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'firefox', testIgnore: perf, use: { browserName: 'firefox' } },
    { name: 'perf', testMatch: perf, dependencies: ['chrome', 'firefox'], use: { browserName: 'chromium', channel: 'chrome' } },
  ],
});
