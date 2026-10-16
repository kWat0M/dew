// 同期再生(F7、5.3 の s)。基準の動画に、ほかの動画の再生・停止・シーク・速度を合わせ続ける。
// 小さなずれは再生速度を少し変えて吸収し、大きなずれはシークで合わせる

/** ずれを見る間隔 */
const CHECK_MS = 200;
/** これより大きなずれ(秒)はシークで合わせる */
const SEEK_DRIFT = 0.5;
/** これより小さなずれ(秒)は直さない */
const DEAD_ZONE = 0.008;
/** ずれ1秒あたりの速度の補正量と、その上限 */
const GAIN = 1.5;
const MAX_ADJUST = 0.15;

/** 最後に表示したフレームの時刻と、それを表示した時刻 */
type Shown = { mediaTime: number; at: number };

export class SyncGroup {
  private timer: number | null = null;
  private readonly shown = new Map<HTMLVideoElement, Shown>();
  private readonly handles = new Map<HTMLVideoElement, number>();

  constructor(
    private readonly master: HTMLVideoElement,
    private readonly followers: HTMLVideoElement[],
  ) {}

  start() {
    for (const ev of ['play', 'pause', 'seeking', 'ratechange'] as const) this.master.addEventListener(ev, this.follow);
    this.timer = window.setInterval(this.correct, CHECK_MS);
    for (const v of [this.master, ...this.followers]) this.watch(v);
    this.follow();
  }

  stop() {
    for (const ev of ['play', 'pause', 'seeking', 'ratechange'] as const) this.master.removeEventListener(ev, this.follow);
    if (this.timer !== null) clearInterval(this.timer);
    for (const [v, h] of this.handles) v.cancelVideoFrameCallback(h);
    for (const f of this.followers) f.playbackRate = this.master.playbackRate;
  }

  /** 基準の再生・停止・位置・速度をそのまま写す */
  private follow = () => {
    const m = this.master;
    for (const f of this.followers) {
      f.playbackRate = m.playbackRate;
      if (Math.abs(f.currentTime - this.target(f)) > DEAD_ZONE) f.currentTime = this.target(f);
      if (m.paused && !f.paused) f.pause();
      if (!m.paused && f.paused) void f.play().catch(() => {});
    }
  };

  /** 再生中のずれを直す */
  private correct = () => {
    const m = this.master;
    if (m.paused || m.seeking) return;
    for (const f of this.followers) {
      if (f.seeking) continue;
      if (f.paused) void f.play().catch(() => {});
      const drift = this.position(f) - Math.min(this.position(m), Number.isFinite(f.duration) ? f.duration : Infinity);
      if (Math.abs(drift) > SEEK_DRIFT) {
        f.currentTime = this.target(f);
      } else if (Math.abs(drift) > DEAD_ZONE) {
        const adjust = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, -drift * GAIN));
        f.playbackRate = m.playbackRate * (1 + adjust);
      } else {
        f.playbackRate = m.playbackRate;
      }
    }
  };

  /** 表示したフレームを追う(画面に出ている位置でずれを測るため) */
  private watch(v: HTMLVideoElement) {
    const onFrame: VideoFrameRequestCallback = (now, meta) => {
      this.shown.set(v, { mediaTime: meta.mediaTime, at: meta.expectedDisplayTime || now });
      this.handles.set(v, v.requestVideoFrameCallback(onFrame));
    };
    this.handles.set(v, v.requestVideoFrameCallback(onFrame));
  }

  /**
   * 今画面に出ている位置の見積もり。currentTime はデコードの遅れの分だけ表示とずれることがあるので、
   * 最後に表示したフレームの時刻から進めて求める。まだ表示していなければ currentTime
   */
  private position(v: HTMLVideoElement) {
    const s = this.shown.get(v);
    if (!s || v.seeking) return v.currentTime;
    const elapsed = Math.max(0, performance.now() - s.at) / 1000;
    // 最後の表示から時間が空きすぎていたら(止まっていた等)使わない
    return elapsed > 0.5 ? v.currentTime : s.mediaTime + elapsed * v.playbackRate;
  }

  /** 追う側の長さを超えないようにした、基準の位置 */
  private target(f: HTMLVideoElement) {
    const t = this.master.currentTime;
    return Number.isFinite(f.duration) ? Math.min(t, f.duration) : t;
  }
}
