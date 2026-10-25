import { useCallback, useLayoutEffect, useRef } from 'react';

/** 中身は毎回新しくなるが、渡す関数は変わらないコールバック(memo した子に渡しても描き直させない) */
export function useStable<A extends unknown[], R = void>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
