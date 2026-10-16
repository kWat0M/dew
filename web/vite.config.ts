import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Windows のブラウザから開くため全インターフェイスで待ち受ける。API と WebSocket は dew サーバへ転送する
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'https://localhost:8765', secure: false },
      '/ws': { target: 'wss://localhost:8765', ws: true, secure: false },
    },
  },
  test: { environment: 'jsdom' },
});
