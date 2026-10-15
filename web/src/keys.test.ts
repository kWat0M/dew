import { describe, expect, test } from 'vitest';
import { KeySequence, readKey } from './keys';

const ev = (key: string, code = '', opts: Partial<KeyboardEvent> = {}) =>
  ({ key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...opts }) as KeyboardEvent;

describe('readKey', () => {
  test('key をそのまま使う(JIS 配列の [ も刻印どおり)', () => {
    expect(readKey(ev('j', 'KeyJ'))).toEqual({ key: 'j', ime: false });
    expect(readKey(ev('[', 'BracketRight'))).toEqual({ key: '[', ime: false });
    expect(readKey(ev('J', 'KeyJ', { shiftKey: true }))?.key).toBe('J');
    expect(readKey(ev(' ', 'Space'))?.key).toBe(' ');
  });

  test('IME が有効なときは英字・数字を code で判定する', () => {
    expect(readKey(ev('Process', 'KeyJ'))).toEqual({ key: 'j', ime: true });
    expect(readKey(ev('Process', 'KeyL', { shiftKey: true }))).toEqual({ key: 'L', ime: true });
    expect(readKey(ev('Process', 'Digit5'))).toEqual({ key: '5', ime: true });
    expect(readKey(ev('Process', 'Period'))).toBeNull();
  });

  test('変換中・修飾キー・Ctrl 系は無視する。Ctrl+] だけは使う', () => {
    expect(readKey(ev('j', 'KeyJ', { isComposing: true }))).toBeNull();
    expect(readKey(ev('Shift', 'ShiftLeft'))).toBeNull();
    expect(readKey(ev('w', 'KeyW', { ctrlKey: true }))).toBeNull();
    expect(readKey(ev(']', 'Backslash', { ctrlKey: true }))?.key).toBe('C-]');
  });
});

describe('KeySequence', () => {
  test('1打鍵と複数打鍵', () => {
    const s = new KeySequence({ j: 'down', 'g g': 'top', G: 'bottom', ' ': 'space', 'w 1': 'win1', 'w x': 'close' });
    expect(s.push('j')).toBe('down');
    expect(s.push('g')).toBe('pending');
    expect(s.push('g')).toBe('top');
    expect(s.push('G')).toBe('bottom');
    expect(s.push('w')).toBe('pending');
    expect(s.candidates().map(([k]) => k).sort()).toEqual(['1', 'x']);
    expect(s.push('x')).toBe('close');
    expect(s.push('w')).toBe('pending');
    expect(s.push('q')).toBeNull();
    expect(s.push('j')).toBe('down');
    expect(s.push(' ')).toBe('space');
  });
});
