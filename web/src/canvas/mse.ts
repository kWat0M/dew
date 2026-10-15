// 変換が必要な動画を Media Source Extensions で再生する(7.4)。
// サーバは6秒単位のセグメントを 0 秒始まりで返すので、timestampOffset を「番号 × 長さ」にして並べる。
// 再生位置の少し先までを読み込み、遠く後ろのものは捨ててメモリを抑える
import { api, ApiError } from '../api/http';
import type { Probe } from '../protocol/Probe';

/** 再生位置からこの秒数先までを読んでおく */
const AHEAD_SECS = 15;
/** 再生位置よりこの秒数以上前は捨てる */
const BEHIND_SECS = 60;

export class TranscodeSource {
  /** 読み込み済みのセグメント番号(シークバーに薄く表示する) */
  readonly loaded = new Set<number>();
  private readonly ms = new MediaSource();
  private sb: SourceBuffer | null = null;
  private busy = false;
  private disposed = false;
  private readonly url: string;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly path: string,
    private readonly probe: Probe,
    private readonly onChange: () => void,
    private readonly onError: (message: string) => void,
  ) {
    this.url = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', this.open, { once: true });
    video.addEventListener('seeking', this.pump);
    video.addEventListener('timeupdate', this.pump);
    video.src = this.url;
  }

  dispose() {
    this.disposed = true;
    this.video.removeEventListener('seeking', this.pump);
    this.video.removeEventListener('timeupdate', this.pump);
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }

  private open = () => {
    const codecs = ['avc1.640028', this.probe.audioCodec ? 'mp4a.40.2' : null].filter(Boolean).join(', ');
    this.ms.duration = this.probe.duration;
    this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${codecs}"`);
    this.sb.mode = 'segments';
    void this.pump();
  };

  /** 必要なセグメントを1つずつ読み込む */
  private pump = async () => {
    if (this.busy || this.disposed || !this.sb) return;
    this.busy = true;
    try {
      for (;;) {
        const index = this.next();
        if (index === null || this.disposed) break;
        await this.evict();
        await this.append(index);
      }
      const all = this.loaded.size === this.probe.segmentCount;
      if (all && this.ms.readyState === 'open') this.ms.endOfStream();
    } catch (e) {
      if (!this.disposed) this.onError(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  };

  /** 次に読むセグメント。再生位置を含むものを最優先にする */
  private next(): number | null {
    const secs = this.probe.segmentSecs;
    const t = this.video.currentTime;
    const first = Math.min(this.probe.segmentCount - 1, Math.floor(t / secs));
    const last = Math.min(this.probe.segmentCount - 1, Math.floor((t + AHEAD_SECS) / secs));
    for (let i = first; i <= last; i++) if (!this.loaded.has(i)) return i;
    return null;
  }

  private async append(index: number) {
    const res = await fetch(api.segmentUrl(this.path, index));
    if (!res.ok) throw new ApiError(res.status, await res.text());
    const data = await res.arrayBuffer();
    if (this.disposed) return;
    const sb = this.sb!;
    sb.timestampOffset = index * this.probe.segmentSecs;
    await this.done(() => sb.appendBuffer(data));
    this.loaded.add(index);
    this.onChange();
  }

  private async evict() {
    const secs = this.probe.segmentSecs;
    const before = Math.floor((this.video.currentTime - BEHIND_SECS) / secs);
    if (before <= 0 || ![...this.loaded].some((i) => i < before)) return;
    const sb = this.sb!;
    await this.done(() => sb.remove(0, before * secs));
    for (const i of [...this.loaded]) if (i < before) this.loaded.delete(i);
    this.onChange();
  }

  private done(f: () => void): Promise<void> {
    const sb = this.sb!;
    return new Promise((ok, ng) => {
      sb.addEventListener('updateend', () => ok(), { once: true });
      sb.addEventListener('error', () => ng(new Error('SourceBuffer error')), { once: true });
      f();
    });
  }
}
