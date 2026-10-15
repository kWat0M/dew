import { useEffect, useLayoutEffect, useRef } from 'react';
import { readKey, type KeyInfo } from './keys';

/** 入力欄に文字を打っている間は、キーマップを効かせない */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** 有効な間、ページ全体のキー入力を受け取る */
export function useKeys(handler: (k: KeyInfo, e: KeyboardEvent) => void, enabled: boolean) {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const f = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      const k = readKey(e);
      if (k) ref.current(k, e);
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [enabled]);
}
