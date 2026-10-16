// サーバの HTTP API。型は crates/protocol から ts-rs で生成したもの
import type { Info } from '../protocol/Info';
import type { Probe } from '../protocol/Probe';
import type { Tree } from '../protocol/Tree';

/** API の失敗。message はサーバが返した日本語の説明 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (await res.json()) as T;
}

const q = (path: string) => `path=${encodeURIComponent(path)}`;

export const api = {
  info: () => getJson<Info>('/api/info'),
  tree: (path: string) => getJson<Tree>(`/api/tree?${q(path)}`),
  probe: (path: string) => getJson<Probe>(`/api/probe?${q(path)}`),
  /** 更新時刻を付けて、ファイルが変わったらブラウザのキャッシュを使わないようにする */
  thumbUrl: (path: string, mtime: number) => `/api/thumb?${q(path)}&v=${mtime}`,
  spriteUrl: (path: string) => `/api/sprite?${q(path)}`,
  mediaUrl: (path: string) => `/api/media?${q(path)}`,
  segmentUrl: (path: string, index: number) => `/api/media?${q(path)}&transcode=1&seg=${index}`,
};
