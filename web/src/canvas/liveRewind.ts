// ライブ表示の一時停止・巻き戻し(L7)。受け取った H.264 を直近 30 秒ぶん持っておき、一時停止中や
// 巻き戻した位置の表示は、別の復号器でキーフレームから復号し直して描く(サーバは変えない)

/** 受け取ったフレーム1つ(ts は受け取った時刻、マイクロ秒) */
export type Chunk = { key: boolean; ts: number; data: Uint8Array };

/** 持っておく長さ(9.1 の直近バッファ) */
export const KEEP_US = 30_000_000;

/** 直近のフレーム。先頭は必ずキーフレームで、KEEP_US より少し長めに持つ */
export class LiveBuffer {
  chunks: Chunk[] = [];

  push(c: Chunk) {
    if (!this.chunks.length && !c.key) return;
    this.chunks.push(c);
    // KEEP_US より古いキーフレームのうち最も新しいものより前は要らない
    const limit = c.ts - KEEP_US;
    let cut = 0;
    for (let i = 1; i < this.chunks.length && this.chunks[i]!.ts <= limit; i++) if (this.chunks[i]!.key) cut = i;
    if (cut > 0) this.chunks.splice(0, cut);
  }

  clear() {
    this.chunks = [];
  }

  get start() {
    return this.chunks[0]?.ts ?? 0;
  }

  get end() {
    return this.chunks.at(-1)?.ts ?? 0;
  }

  /** ts 以下の最後のフレームの位置(なければ -1) */
  indexAt(ts: number) {
    let lo = 0;
    let hi = this.chunks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.chunks[mid]!.ts <= ts) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /** ts を表示するのに復号するフレーム(ts 以前の最後のキーフレームから、ts 以下の最後のフレームまで) */
  framesFor(ts: number): Chunk[] {
    const last = this.indexAt(ts);
    if (last < 0) return [];
    let key = last;
    while (key > 0 && !this.chunks[key]!.key) key--;
    return this.chunks.slice(key, last + 1);
  }
}

type Mode = 'live' | 'paused' | 'playing';

export class LiveRewind {
  readonly buffer = new LiveBuffer();
  private cfg: VideoDecoderConfig | null = null;
  private decoder: VideoDecoder | null = null;
  private mode: Mode = 'live';
  /** 表示中のフレームの時刻 */
  private pos = 0;
  /** これより前のフレームは描かない(シークで途中のフレームを見せないため) */
  private target = -1;
  private playFrom = 0;
  private wallFrom = 0;
  private raf = 0;
  /** 描く先(ライブの映像と同じ canvas) */
  private canvas: HTMLCanvasElement | null = null;
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  setCanvas(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
  }

  private draw(frame: VideoFrame) {
    this.canvas?.getContext('2d')!.drawImage(frame, 0, 0);
    frame.close();
  }

  /** 映像の設定が変わった(大きさが変わって作り直されたなど)。前のフレームは復号できないので捨てる */
  configure(cfg: VideoDecoderConfig) {
    this.cfg = cfg;
    this.buffer.clear();
    this.decoder?.close();
    this.decoder = null;
    this.goLive();
  }

  /** 届いたフレームを持っておく。ライブ表示中なら true(呼び出し側が復号して描く) */
  push(c: Chunk): boolean {
    this.buffer.push(c);
    if (this.mode !== 'live') return false;
    this.pos = c.ts;
    return true;
  }

  isLive() {
    return this.mode === 'live';
  }

  isPaused() {
    return this.mode === 'paused';
  }

  /** 表示中の位置と、持っている範囲(マイクロ秒) */
  state() {
    return { mode: this.mode, pos: this.pos, start: this.buffer.start, end: this.buffer.end };
  }

  pause() {
    if (!this.buffer.chunks.length) return;
    cancelAnimationFrame(this.raf);
    this.mode = 'paused';
    this.onChange();
  }

  /** 一時停止した位置から、実際の速さで再生する。持っている最後に追いついたらライブに戻る */
  play() {
    if (this.mode !== 'paused') return;
    // 復号器を今の位置まで進めておく。一時停止中の表示に使った flush の後は、WebCodecs の決まりで
    // キーフレームからでないと続けられないので、flush せずにキーフレームから復号し直す
    this.show(this.pos, false);
    this.mode = 'playing';
    // 追いつくために復号し直した、今より前のフレームは描かない
    this.target = this.pos;
    this.playFrom = this.pos;
    this.wallFrom = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.onChange();
  }

  toggle() {
    if (this.mode === 'paused') this.play();
    else this.pause();
  }

  goLive() {
    cancelAnimationFrame(this.raf);
    this.mode = 'live';
    this.onChange();
  }

  seekTo(ts: number) {
    const { start, end } = this.buffer;
    if (!this.buffer.chunks.length) return;
    // 持っている最後より先はライブ
    if (ts >= end) return this.goLive();
    const playing = this.mode === 'playing';
    cancelAnimationFrame(this.raf);
    this.mode = 'paused';
    this.show(Math.max(ts, start));
    if (playing) this.play();
    else this.onChange();
  }

  seekBy(sec: number) {
    this.seekTo(this.pos + sec * 1_000_000);
  }

  seekFraction(f: number) {
    const { start, end } = this.buffer;
    this.seekTo(start + f * (end - start));
  }

  /** 1フレーム戻る / 進む(一時停止中) */
  step(dir: 1 | -1) {
    if (this.mode === 'live') this.pause();
    if (this.mode !== 'paused') return;
    const i = this.buffer.indexAt(this.pos) + dir;
    const c = this.buffer.chunks[i];
    if (c) this.show(c.ts);
    this.onChange();
  }

  close() {
    cancelAnimationFrame(this.raf);
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }

  private dec(): VideoDecoder | null {
    if (!this.cfg) return null;
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          // ライブに戻った後に出てきたもの、シークの途中のものは描かない
          if (this.mode === 'live' || frame.timestamp < this.target) return frame.close();
          this.draw(frame);
        },
        error: () => {},
      });
    }
    return this.decoder;
  }

  private feed(c: Chunk) {
    this.decoder?.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.data }));
  }

  /** ts のフレームを、キーフレームから復号し直して描く。flush すると最後のフレームまで確実に出る(一時停止中の表示) */
  private show(ts: number, flush = true) {
    const frames = this.buffer.framesFor(ts);
    const d = this.dec();
    if (!frames.length || !d || !this.cfg) return;
    d.reset();
    d.configure(this.cfg);
    this.target = frames.at(-1)!.ts;
    for (const c of frames) this.feed(c);
    if (flush) void d.flush().catch(() => {});
    this.pos = this.target;
  }

  private tick = () => {
    if (this.mode !== 'playing') return;
    const now = this.playFrom + (performance.now() - this.wallFrom) * 1000;
    const chunks = this.buffer.chunks;
    let i = this.buffer.indexAt(this.pos) + 1;
    // 古いフレームが捨てられて位置がなくなっていたら、そこからはやり直せないのでキーフレームから
    if (i === 0) return this.seekTo(this.buffer.start);
    for (; i < chunks.length && chunks[i]!.ts <= now; i++) {
      this.feed(chunks[i]!);
      this.pos = chunks[i]!.ts;
    }
    if (i >= chunks.length) return this.goLive();
    this.raf = requestAnimationFrame(this.tick);
  };
}
