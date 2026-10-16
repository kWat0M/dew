// キャンバス上のウィンドウ配置(4.2)。1つなら最大化、2つ以上はタイル(左右・グリッド)か自由配置

export type Rect = { x: number; y: number; w: number; h: number };
export type Dir = 'h' | 'j' | 'k' | 'l';

const GAP = 8;

/** タイル配置。2つは左右、それ以上は列数 ceil(√n) のグリッド */
export function tile(n: number, width: number, height: number): Rect[] {
  if (n === 0) return [];
  const cols = n === 2 ? 2 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = (width - GAP * (cols + 1)) / cols;
  const h = (height - GAP * (rows + 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: GAP + (i % cols) * (w + GAP),
    y: GAP + Math.floor(i / cols) * (h + GAP),
    w,
    h,
  }));
}

/** 自由配置の初期位置。少しずつずらして重ねる */
export function cascade(index: number, width: number, height: number): Rect {
  const w = Math.max(320, width * 0.5);
  const h = Math.max(240, height * 0.55);
  const step = 32 * (index % 8);
  return { x: GAP + step, y: GAP + step, w, h };
}

/** `from` から見て `dir` の方向にある、いちばん近いウィンドウの番号 */
export function neighbor(rects: readonly Rect[], from: number, dir: Dir): number | null {
  const a = rects[from];
  if (!a) return null;
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  let best: number | null = null;
  let bestScore = Infinity;
  rects.forEach((b, i) => {
    if (i === from) return;
    const dx = b.x + b.w / 2 - ca.x;
    const dy = b.y + b.h / 2 - ca.y;
    const along = { h: -dx, l: dx, k: -dy, j: dy }[dir];
    const across = dir === 'h' || dir === 'l' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) return;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
