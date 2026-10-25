// サーバの HTTP API。型は crates/protocol から ts-rs で生成したもの
import type { CsvMatches } from '../protocol/CsvMatches';
import type { CsvOptions } from '../protocol/CsvOptions';
import type { CsvPage } from '../protocol/CsvPage';
import type { CsvPreview } from '../protocol/CsvPreview';
import type { CsvQuery } from '../protocol/CsvQuery';
import type { CsvRows } from '../protocol/CsvRows';
import type { CsvSchema } from '../protocol/CsvSchema';
import type { CsvSearch } from '../protocol/CsvSearch';
import type { CsvView } from '../protocol/CsvView';
import type { DownloadSize } from '../protocol/DownloadSize';
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

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (await res.json()) as T;
}

const q = (path: string) => `path=${encodeURIComponent(path)}`;

/** CSV の読み方の手動設定をクエリにする */
const csvq = (path: string, o: CsvOptions) =>
  q(path) +
  (o.encoding ? `&encoding=${o.encoding}` : '') +
  (o.delimiter ? `&delimiter=${encodeURIComponent(o.delimiter)}` : '') +
  (o.header !== undefined ? `&header=${o.header}` : '');

export const api = {
  info: () => getJson<Info>('/api/info'),
  /** 保存する前の合計(18.3) */
  downloadSize: (paths: string[]) => getJson<DownloadSize>(`/api/download/size?${paths.map(q).join('&')}`),
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
  /** CSV(16.8): モード・列など。大規模モードで読み込み中なら ready が false */
  csvSchema: (path: string, o: CsvOptions) => getJson<CsvSchema>(`/api/csv/schema?${csvq(path, o)}`),
  /** Home のプレビュー: 先頭20行・最大10列(15.5) */
  csvPreview: (path: string) => getJson<CsvPreview>(`/api/csv/preview?${q(path)}`),
  /** 小規模モードの全行 */
  csvRows: (path: string, o: CsvOptions) => getJson<CsvRows>(`/api/csv/rows?${csvq(path, o)}`),
  /** 大規模モードのページ */
  csvQuery: (body: CsvQuery, signal?: AbortSignal) => postJson<CsvPage>('/api/csv/query', body, signal),
  /** 大規模モードの検索 */
  csvSearch: (body: CsvSearch, signal?: AbortSignal) => postJson<CsvMatches>('/api/csv/search', body, signal),
  /** 並べ替え・フィルター後の、元の行番号の位置(: 行番号)。見つからなければ null */
  csvLocate: (body: CsvSearch & { row: number }) => postJson<number | null>('/api/csv/locate', body),
  /** 表示設定(16.6)。なければ null */
  csvView: (path: string) => getJson<CsvView | null>(`/api/csv/view?${q(path)}`),
  saveCsvView: (path: string, view: CsvView) =>
    // keepalive: 変えた直後にタブを読み直しても届くように
    void fetch(`/api/csv/view?${q(path)}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(view) }).catch(() => {}),
  /** 大規模モードの読み込みをやめる(ウィンドウを閉じたとき) */
  csvCancel: (path: string) => void fetch(`/api/csv/cancel?${q(path)}`, { method: 'POST' }).catch(() => {}),
  segmentUrl: (path: string, index: number) => `/api/media?${q(path)}&transcode=1&seg=${index}`,
};
