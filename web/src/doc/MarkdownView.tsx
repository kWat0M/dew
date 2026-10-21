// Markdown の描画(17.1)。react-markdown・KaTeX・色分けはこのチャンクにだけ入れ、最初に開いたときに読み込む(15.6)
import { memo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { api } from '../api/http';
import { ja } from '../i18n/ja';
import { classifyImage, classifyLink, urlTransform, type Link } from './links';
import './markdown.css';

/** 既定のスキーマに、数式と色分けが使う class と、data:image の画像を足したもの(17.1) */
const schema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'data'] },
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math-display']],
  },
};

const remarkPlugins = [remarkGfm, remarkMath, remarkFrontmatter];
const rehypePlugins = [
  // 先に危険な要素・属性を除き、そのあとで見出しの id を付ける(sanitize は id の頭に user-content- を付けるため)
  [rehypeSanitize, schema],
  rehypeSlug,
  // 誤った数式はその式だけを error 色で出す(色は MD3 のトークン)
  [rehypeKatex, { throwOnError: false, trust: false, errorColor: 'var(--md-sys-color-error)' }],
  rehypeHighlight,
] as const;

/** 先頭の `---` で囲んだフロントマター */
export function splitFrontmatter(text: string): { meta: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return m ? { meta: m[1]!, body: text.slice(m[0].length) } : { meta: null, body: text };
}

type Props = {
  text: string;
  /** この文書のパス(相対リンク・画像の起点) */
  path: string;
  /** 閲覧範囲の起点(外の画像は出さない) */
  root: string;
  /** 外部の画像を、クリックを待たずに読み込む */
  externalImages: boolean;
  /** リンクを押した。ない(プレビュー)ときは、リンクを押しても何もしない */
  onLink?: (link: Link, newWindow: boolean) => void;
};

/** 外部の画像: 既定では読み込まず、クリックで読み込む(追跡やオフライン時の待ちを避ける。17.2) */
function ExternalImage({ url, host, alt }: { url: string; host: string; alt: string }) {
  const [load, setLoad] = useState(false);
  if (load) return <img src={url} alt={alt} referrerPolicy="no-referrer" />;
  return (
    <button type="button" className="md-external-image" data-testid="external-image" onClick={() => setLoad(true)}>
      {host} — {ja.loadExternalImage}
    </button>
  );
}

function MarkdownViewInner({ text, path, root, externalImages, onLink }: Props) {
  const { meta, body } = splitFrontmatter(text);
  const components: Components = {
    a: ({ href, children }) => {
      const raw = href ?? '';
      const link = classifyLink(path, raw);
      if (link.kind === 'none') return <span className="md-dead-link">{children}</span>;
      if (link.kind === 'external')
        return (
          <a href={raw} data-href={raw} data-kind="external" target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      return (
        <a
          href={raw}
          data-href={raw}
          data-kind={link.kind}
          onClick={(e) => {
            e.preventDefault();
            onLink?.(link, e.shiftKey || e.ctrlKey || e.metaKey);
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      const s = classifyImage(path, root, typeof src === 'string' ? src : '');
      const a = alt ?? '';
      switch (s.kind) {
        case 'local':
          return <img src={api.mediaUrl(s.path)} alt={a} loading="lazy" />;
        case 'data':
          return <img src={s.url} alt={a} />;
        case 'external':
          return externalImages ? <img src={s.url} alt={a} referrerPolicy="no-referrer" /> : <ExternalImage url={s.url} host={s.host} alt={a} />;
        case 'outside':
          return (
            <span className="md-blocked">
              {ja.outsideRoot}
              {a && `: ${a}`}
            </span>
          );
        default:
          return <span className="md-blocked">{a}</span>;
      }
    },
    // 幅の広い表とコードは、その場で横にスクロールできるようにする(h / l でも動かす)
    table: ({ children }) => (
      <div className="md-wide">
        <table>{children}</table>
      </div>
    ),
    pre: ({ children }) => <pre className="md-wide">{children}</pre>,
  };
  return (
    <>
      {meta !== null && (
        <details className="md-frontmatter" data-testid="doc-frontmatter">
          <summary>{ja.frontmatter}</summary>
          <pre>{meta}</pre>
        </details>
      )}
      <div className="md-body" data-testid="doc-body">
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} urlTransform={urlTransform} components={components}>
          {body}
        </Markdown>
      </div>
    </>
  );
}

/** 本文が同じなら描き直さない(スクロールやヒントの表示で、描画をやり直さないように) */
const MarkdownView = memo(MarkdownViewInner);
export default MarkdownView;
