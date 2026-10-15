import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App';
import { ja } from './i18n/ja';

test('タイトルを表示する', () => {
  render(<App />);
  expect(screen.getByRole('heading').textContent).toBe(ja.appTitle);
});
