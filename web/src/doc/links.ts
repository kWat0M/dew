// Markdown のリンクと画像の行き先(17.2)。描画のチャンクとキー操作の両方から使うので、ライブラリを含めない

/** リンクの種類 */
export type LinkKind =
  /** 相対パスの .md(同じウィンドウ内で移動) */
  | 'markdown'
  /** 相対パスのそのほか(dew で開く。ディレクトリなら Home) */
  | 'path'
  /** ページ内の見出し */
  | 'anchor'
  /** http(s)・mailto(ブラウザの新しいタブ) */
  | 'external'
  /** javascript: など(リンクにしない) */
  | 'none';

export type Link = { kind: LinkKind; /** markdown・path は絶対パス、anchor は見出しの id、external は URL */ target: string; /** 移動先で開く見出し(b.md#節) */ hash?: string };

const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `/a/b/../c` を `/a/c` にする */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** 文書 `doc` から見た相対パスを絶対パスにする(%xx は戻す) */
export function resolvePath(doc: string, rel: string): string {
  let p = rel;
  try {
    p = decodeURIComponent(rel);
  } catch {
    // 壊れたエスケープはそのまま
  }
  return normalize(p.startsWith('/') ? p : `${dirname(doc)}/${p}`);
}

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** リンクの行き先を決める */
export function classifyLink(doc: string, href: string): Link {
  const h = href.trim();
  if (h === '') return { kind: 'none', target: '' };
  if (h.startsWith('#')) return { kind: 'anchor', target: safeDecode(h.slice(1)) };
  if (EXTERNAL.test(h)) return { kind: 'external', target: h };
  if (SCHEME.test(h) || h.startsWith('//')) return { kind: 'none', target: '' };
  const [pathPart, hash] = splitHash(h.split('?')[0]!);
  const target = resolvePath(doc, pathPart);
  if (isMarkdown(target)) return { kind: 'markdown', target, hash };
  return { kind: 'path', target, hash };
}

/** 画像の出し方 */
export type ImageSrc =
  { kind: 'local'; path: string } | { kind: 'outside'; path: string } | { kind: 'external'; url: string; host: string } | { kind: 'data'; url: string } | { kind: 'none' };

export function classifyImage(doc: string, root: string, src: string): ImageSrc {
  const s = src.trim();
  if (/^data:image\//i.test(s)) return { kind: 'data', url: s };
  if (/^https?:/i.test(s)) {
    let host = s;
    try {
      host = new URL(s).host;
    } catch {
      // 読めない URL はそのまま見せる
    }
    return { kind: 'external', url: s, host };
  }
  if (s === '' || SCHEME.test(s) || s.startsWith('//')) return { kind: 'none' };
  const path = resolvePath(doc, splitHash(s.split('?')[0]!)[0]);
  const r = root.endsWith('/') ? root : root + '/';
  return path === root || path.startsWith(r) ? { kind: 'local', path } : { kind: 'outside', path };
}

function splitHash(s: string): [string, string | undefined] {
  const i = s.indexOf('#');
  return i < 0 ? [s, undefined] : [s.slice(0, i), safeDecode(s.slice(i + 1))];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** react-markdown の urlTransform: data:image だけを足し、ほかは安全な URL と相対パスに限る */
export function urlTransform(url: string, key: string): string {
  if (key === 'src' && /^data:image\//i.test(url.trim())) return url;
  const u = url.trim();
  if (u.startsWith('#') || EXTERNAL.test(u)) return u;
  if (SCHEME.test(u) || u.startsWith('//')) return '';
  return u;
}
