// 右カラム: 選択中の項目のプレビューとメタ情報
import { useEffect, useState } from 'react';
import { api } from '../api/http';
import type { Entry } from '../protocol/Entry';
import type { Probe } from '../protocol/Probe';
import type { Tree } from '../protocol/Tree';
import { formatDate, formatSize, formatTime, join } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { iconFor, Thumb } from './EntryList';

export function Preview({ dir, entry, showHidden }: { dir: string; entry: Entry | undefined; showHidden: boolean }) {
  const path = entry ? join(dir, entry.name) : null;
  const [probe, setProbe] = useState<{ path: string; probe: Probe } | null>(null);
  const [children, setChildren] = useState<{ path: string; tree: Tree } | null>(null);

  useEffect(() => {
    if (!entry || !path || !entry.readable) return;
    let alive = true;
    if (entry.kind === 'dir') {
      api.tree(path).then((tree) => alive && setChildren({ path, tree }), () => {});
    } else if (entry.media === 'video' || entry.media === 'audio') {
      api.probe(path).then((p) => alive && setProbe({ path, probe: p }), () => {});
    }
    return () => {
      alive = false;
    };
  }, [entry, path]);

  if (!entry || !path) return <div className="preview" data-testid="col-preview" />;
  const info = probe?.path === path ? probe.probe : null;
  const kids = children?.path === path ? children.tree.entries.filter((e) => showHidden || !e.name.startsWith('.')) : null;

  return (
    <div className="preview" data-testid="col-preview">
      <div className="preview-media">
        {!entry.readable ? (
          <Icon name="lock" size={64} />
        ) : entry.kind === 'dir' ? (
          kids === null ? (
            <span className="muted">{ja.loading}</span>
          ) : kids.length === 0 ? (
            <span className="muted">{ja.emptyDir}</span>
          ) : (
            <ul className="preview-children">
              {kids.slice(0, 200).map((k) => (
                <li key={k.name}>
                  <Icon name={iconFor(k)} size={16} />
                  {k.name}
                </li>
              ))}
            </ul>
          )
        ) : entry.media === 'image' ? (
          // サムネイルを作れない(ffmpeg がない)ときは、元の画像をそのまま出す
          <Thumb src={api.thumbUrl(path, entry.mtime)} fallback={<img src={api.mediaUrl(path)} alt="" />} />
        ) : entry.media === 'video' ? (
          // 再生できる形式は無音でループ再生し、変換が必要なものはサムネイルだけ出す
          info && !info.needsTranscode ? (
            <video key={path} src={api.mediaUrl(path)} poster={api.thumbUrl(path, entry.mtime)} muted loop autoPlay playsInline />
          ) : (
            <Thumb src={api.thumbUrl(path, entry.mtime)} fallback={<Icon name="movie" size={64} />} />
          )
        ) : (
          <Icon name={iconFor(entry)} size={64} />
        )}
      </div>
      <dl className="preview-meta">
        {entry.kind === 'file' && (
          <>
            <dt>{ja.size}</dt>
            <dd>{formatSize(entry.size)}</dd>
          </>
        )}
        <dt>{ja.modified}</dt>
        <dd>{formatDate(entry.mtime)}</dd>
        {kids && (
          <>
            <dt />
            <dd>{ja.items(kids.length)}</dd>
          </>
        )}
        {info?.missing.includes('ffprobe') && (
          <>
            <dt />
            <dd className="tool-missing" data-testid="tool-missing">
              {ja.noProbeInfo}({ja.installFfmpeg})
            </dd>
          </>
        )}
        {info?.missing.includes('ffmpeg') && (
          <>
            <dt />
            <dd className="tool-missing" data-testid="tool-missing">
              {ja.noThumbs}({ja.installFfmpeg})
            </dd>
          </>
        )}
        {info && !info.missing.includes('ffprobe') && (
          <>
            <dt>{ja.duration}</dt>
            <dd>{formatTime(info.duration)}</dd>
            {info.width > 0 && (
              <>
                <dt>{ja.resolution}</dt>
                <dd>
                  {info.width}×{info.height} / {info.fps.toFixed(2)} {ja.fps}
                </dd>
              </>
            )}
            <dt>{ja.codec}</dt>
            <dd>
              {[info.videoCodec, info.audioCodec].filter(Boolean).join(' / ')}
              {info.needsTranscode && ` (${ja.needsTranscode})`}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
