// ダウンロード(18.3): 1つのファイルはそのまま、複数とディレクトリは zip にまとめて保存する
import { api } from './api/http';
import type { DownloadSize } from './protocol/DownloadSize';

export type DownloadItem = { path: string; dir: boolean };

/** これより大きいときは、保存する前に確かめる */
export const CONFIRM_BYTES = 1024 ** 3;

/** zip の名前: ディレクトリ1つならその名前、それ以外は dew-年月日-時分秒(この端末の時刻) */
export function zipName(items: DownloadItem[], now = new Date()): string {
  if (items.length === 1 && items[0]!.dir) return `${items[0]!.path.split('/').filter(Boolean).at(-1) ?? 'dew'}.zip`;
  const p = (n: number) => String(n).padStart(2, '0');
  return `dew-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}

/** 1つのファイルなら null。zip にまとめるなら、合計の大きさ(閲覧範囲の外などはここで ApiError になる) */
export async function prepare(items: DownloadItem[]): Promise<DownloadSize | null> {
  if (items.length === 1 && !items[0]!.dir) return null;
  return api.downloadSize(items.map((i) => i.path));
}

/** 保存を始める。ブラウザの保存として受け取り、ページは移らない */
export function start(items: DownloadItem[]) {
  if (items.length === 1 && !items[0]!.dir) {
    const a = document.createElement('a');
    a.href = `/api/download?path=${encodeURIComponent(items[0]!.path)}`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  // パスが多いと URL に収まらないので、フォームで POST する。応答は見えない iframe で受ける
  let frame = document.querySelector<HTMLIFrameElement>('iframe[name="dew-download"]');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.name = 'dew-download';
    frame.hidden = true;
    document.body.append(frame);
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/download';
  form.target = 'dew-download';
  form.hidden = true;
  const field = (name: string, value: string) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  };
  for (const i of items) field('path', i.path);
  field('name', zipName(items));
  document.body.append(form);
  form.submit();
  form.remove();
}
