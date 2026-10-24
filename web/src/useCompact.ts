// 幅の狭い画面(MD3 の Compact window size class、600px 未満。18.2)か。端末の種類では判定しない
import { useSyncExternalStore } from 'react';

export const COMPACT_QUERY = '(max-width: 599.98px)';

// matchMedia がない環境(単体テストの jsdom など)では、幅の広い画面として扱う
const supported = () => typeof matchMedia === 'function';

function subscribe(f: () => void) {
  if (!supported()) return () => {};
  const m = matchMedia(COMPACT_QUERY);
  m.addEventListener('change', f);
  return () => m.removeEventListener('change', f);
}

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => supported() && matchMedia(COMPACT_QUERY).matches);
}
