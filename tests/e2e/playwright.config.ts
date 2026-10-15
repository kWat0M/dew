import { defineConfig } from '@playwright/test';

// 同梱の Chromium は H.264 / AAC を再生できないため、インストール済みの Google Chrome を使う
export default defineConfig({
  testDir: './specs',
  use: { channel: 'chrome', headless: true, ignoreHTTPSErrors: true },
});
