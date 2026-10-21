// サーバの HTTP API。型は crates/protocol から ts-rs で生成したもの
import type { History } from '../protocol/History';
import type { Info } from '../protocol/Info';
import type { Probe } from '../protocol/Probe';
import type { RecordResult } from '../protocol/RecordResult';
import type { TextDoc } from '../protocol/TextDoc';
import type { TextEncoding } from '../protocol/TextEncoding';
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
  history: () => getJson<History>('/api/history'),
  /** UTF-8 にした文書。encoding を渡すと、その文字コードで読む(15.8) */
  text: (path: string, encoding?: TextEncoding) => getJson<TextDoc>(`/api/text?${q(path)}${encoding ? `&encoding=${encoding}` : ''}`),
  /** ライブウィンドウの録画を始める・止める(L7)。止めたときは保存したファイルを返す */
  record: async (window: number, on: boolean): Promise<RecordResult> => {
    const res = await fetch('/api/live/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window, on }),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (await res.json()) as RecordResult;
  },
  /** 開いたファイルを履歴に加える。失敗しても表示には響かないので待たない */
  addHistory: (paths: string[]) =>
    void fetch('/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
    }).catch(() => {}),
  /** 更新時刻を付けて、ファイルが変わったらブラウザのキャッシュを使わないようにする */
  thumbUrl: (path: string, mtime: number) => `/api/thumb?${q(path)}&v=${mtime}`,
  spriteUrl: (path: string) => `/api/sprite?${q(path)}`,
  /** ブラウザで正確に表示できない画像(TIFF、16bit)を 8bit の PNG にしたもの */
  imageUrl: (path: string) => `/api/image?${q(path)}`,
  /** 画像の元の画素値(16bit RGBA) */
  pixelsUrl: (path: string) => `/api/pixels?${q(path)}`,
  mediaUrl: (path: string) => `/api/media?${q(path)}`,
  segmentUrl: (path: string, index: number) => `/api/media?${q(path)}&transcode=1&seg=${index}`,
};
