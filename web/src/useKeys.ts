import { useEffect, useLayoutEffect, useRef } from 'react';
import { readKey, type KeyInfo } from './keys';

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'password', 'number', 'tel']);

/** 文字入力欄に打っている間は、キーマップを効かせない(チェックボックスやスライダーは対象外) */
export function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type);
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
