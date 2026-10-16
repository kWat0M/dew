import { defineConfig } from '@playwright/test';

// Chrome: 同梱の Chromium は H.264 / AAC を再生できないため、インストール済みの Google Chrome を使う。
// Firefox: Zen など Firefox 系への対応を確かめる(playwright install firefox で入れる)
export default defineConfig({
  testDir: './specs',
  use: { headless: true, ignoreHTTPSErrors: true },
  projects: [
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
