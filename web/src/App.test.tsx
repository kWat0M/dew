import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { App } from './App';
import { ja } from './i18n/ja';

test('最初に「クリックかキーで開始」を表示する', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('WebSocket', class { close() {} });
  render(<App />);
  expect(screen.getByTestId('start-overlay').textContent).toContain(ja.startPrompt);
});
