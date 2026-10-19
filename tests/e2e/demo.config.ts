import { defineConfig } from '@playwright/test';

// README の紹介動画を撮る(scripts/demo/record.sh から実行する。ふつうのテストには含めない)
// H.264 を再生するため Chrome を使い、1280x720 で録画する
export default defineConfig({
  testDir: './demo',
  outputDir: process.env.DEW_DEMO_OUT ?? './demo-results',
  timeout: 180_000,
  workers: 1,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  },
});
