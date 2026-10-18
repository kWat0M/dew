// 動画を読み込む: 調べてから、そのまま再生するか変換して再生するかを決める(F2、F3)
import { useEffect, useState, type RefObject } from 'react';
import { api, ApiError } from '../api/http';
import type { Probe } from '../protocol/Probe';
import { ja } from '../i18n/ja';
import { TranscodeSource } from './mse';

/** 範囲 [s, e) を秒で(読み込み済みのセグメント) */
function segmentRanges(loaded: ReadonlySet<number>, secs: number, duration: number): [number, number][] {
  return [...loaded].sort((a, b) => a - b).map((i) => [i * secs, Math.min(duration, (i + 1) * secs)]);
}

type Options = {
  /** 映像のあるファイル(音声だけのファイルではない) */
  video?: boolean;
  /** 調べ終わったとき(再生を始める直前) */
  onProbe?: (p: Probe) => void;
  onError: (message: string) => void;
};

/** `enabled` の間、`path` を `video` に読み込む。調べた結果と、変換済みの範囲を返す */
export function useVideoSource(video: RefObject<HTMLVideoElement | null>, path: string, enabled: boolean, opts: Options) {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [ranges, setRanges] = useState<[number, number][]>([]);
  const { onProbe, onError, video: hasVideo = true } = opts;

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
        // ffprobe がない: 何も分からないので、ブラウザでそのまま再生してみる。長さと大きさは再生する側から取る
        if (pr.missing.includes('ffprobe')) {
          v.addEventListener(
            'loadedmetadata',
            () => {
              if (!alive) return;
              // 映像を復号できない形式(mp4v など)でも、音だけ再生できるとブラウザはエラーにしない。映像の大きさが
              // 分からなければ、映像は出せていない
              if (hasVideo && v.videoWidth === 0) onError(ja.maybeNeedsTranscode);
              const known = { ...pr, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
              setProbe(known);
              onProbe?.(known);
            },
            { once: true },
          );
          v.addEventListener('error', () => alive && onError(ja.maybeNeedsTranscode), { once: true });
          v.src = api.mediaUrl(path);
          void v.play().catch(() => {});
          return;
        }
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
  }, [video, path, enabled, onProbe, onError, hasVideo]);

  return { probe, ranges };
}
