// アップロード(19章): ローカルのファイルを、Home で開いているディレクトリへ送る。
// 1ファイルずつ PUT /api/upload で送る(本文がそのままファイルの中身。進み具合は XHR の upload.onprogress で出す)
import type { UploadResult } from './protocol/UploadResult';

/** 進み具合。done は送り終えたファイルの数、sent / total はバイト数 */
export type UploadProgress = { done: number; count: number; sent: number; total: number };

/** 送り終えたもの。savedAs は保存した名前(同じ名前があると「名前 (1).拡張子」などに変わる) */
export type UploadOutcome = {
  saved: { name: string; savedAs: string }[];
  failed: { name: string; message: string }[];
  canceled: boolean;
};

/** 1ファイルを送る。止められたら null */
function put(dir: string, file: File, onSent: (bytes: number) => void, signal: AbortSignal): Promise<UploadResult | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText) as UploadResult);
      else reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('サーバにつながりません'));
    xhr.onabort = () => resolve(null);
    if (signal.aborted) return resolve(null);
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** 順に送る。1つ失敗しても残りは送る。止められたら、そこで終える(送りかけのものはサーバが消す) */
export async function uploadFiles(dir: string, files: File[], onProgress: (p: UploadProgress) => void, signal: AbortSignal): Promise<UploadOutcome> {
  const total = files.reduce((n, f) => n + f.size, 0);
  const out: UploadOutcome = { saved: [], failed: [], canceled: false };
  let before = 0;
  for (const [i, file] of files.entries()) {
    onProgress({ done: i, count: files.length, sent: before, total });
    try {
      const r = await put(dir, file, (b) => onProgress({ done: i, count: files.length, sent: before + b, total }), signal);
      if (r === null) {
        out.canceled = true;
        break;
      }
      out.saved.push({ name: file.name, savedAs: r.name });
    } catch (e) {
      out.failed.push({ name: file.name, message: e instanceof Error ? e.message : String(e) });
    }
    before += file.size;
  }
  onProgress({ done: out.saved.length + out.failed.length, count: files.length, sent: before, total });
  return out;
}

/** ドロップされたもののうちファイルだけ(ディレクトリは送らない)。skipped はディレクトリの数 */
export function droppedFiles(dt: DataTransfer): { files: File[]; skipped: number } {
  const files: File[] = [];
  let skipped = 0;
  const items = [...dt.items].filter((it) => it.kind === 'file');
  if (items.length === 0) return { files: [...dt.files], skipped: 0 };
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      skipped++;
      continue;
    }
    const f = it.getAsFile();
    if (f) files.push(f);
  }
  return { files, skipped };
}

/** ドラッグ中のものにファイルが含まれるか(ページ内の文字などのドラッグでは反応しない) */
export const hasFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes('Files');
