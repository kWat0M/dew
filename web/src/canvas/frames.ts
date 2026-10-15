// フレーム番号と時刻の変換(7.5)。ffprobe のフレームごとの時刻を使い、可変フレームレートでもずれないようにする

/** 時刻のゆらぎの許容(秒) */
const EPS = 1e-3;

/** `t` 秒に表示されているフレームの番号(t 以下で最後のフレーム) */
export function frameAt(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return 0;
  if (t < times[0]! - EPS) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t + EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * フレーム `n` を表示するためにシークする時刻。境界ちょうどだと前のフレームが出ることがあるので、
 * フレームの表示期間の 1/4 だけ後ろにする
 */
export function seekTimeFor(times: readonly number[], n: number, duration: number): number {
  const i = Math.max(0, Math.min(times.length - 1, n));
  const t = times[i] ?? 0;
  const next = times[i + 1] ?? duration;
  return t + Math.max(0, next - t) / 4;
}

/** `t` 秒以降で最初のフレームの番号(0–9 キーの移動先) */
export function frameFrom(times: readonly number[], t: number): number {
  const i = frameAt(times, t);
  return (times[i] ?? 0) < t - EPS ? Math.min(i + 1, times.length - 1) : i;
}
