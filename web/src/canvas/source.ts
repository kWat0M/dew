// 動画を読み込む: 調べてから、そのまま再生するか変換して再生するかを決める(F2、F3)
import { useEffect, useState, type RefObject } from 'react';
import { api, ApiError } from '../api/http';
import type { Probe } from '../protocol/Probe';
import { TranscodeSource } from './mse';

/** 範囲 [s, e) を秒で(読み込み済みのセグメント) */
function segmentRanges(loaded: ReadonlySet<number>, secs: number, duration: number): [number, number][] {
  return [...loaded].sort((a, b) => a - b).map((i) => [i * secs, Math.min(duration, (i + 1) * secs)]);
}

type Options = {
  /** 調べ終わったとき(再生を始める直前) */
  onProbe?: (p: Probe) => void;
  onError: (message: string) => void;
};

/** `enabled` の間、`path` を `video` に読み込む。調べた結果と、変換済みの範囲を返す */
export function useVideoSource(video: RefObject<HTMLVideoElement | null>, path: string, enabled: boolean, opts: Options) {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [ranges, setRanges] = useState<[number, number][]>([]);
  const { onProbe, onError } = opts;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let source: TranscodeSource | null = null;
    api.probe(path).then(
      (pr) => {
        if (!alive) return;
        setProbe(pr);
        onProbe?.(pr);
        const v = video.current!;
        if (pr.needsTranscode) {
          source = new TranscodeSource(
            v,
            path,
            pr,
            () => alive && setRanges(segmentRanges(source!.loaded, pr.segmentSecs, pr.duration)),
            (m) => alive && onError(m),
          );
        } else {
          v.src = api.mediaUrl(path);
        }
        void v.play().catch(() => {});
      },
      (e: unknown) => alive && onError(e instanceof ApiError ? e.message : String(e)),
    );
    return () => {
      alive = false;
      source?.dispose();
    };
  }, [video, path, enabled, onProbe, onError]);

  return { probe, ranges };
}
