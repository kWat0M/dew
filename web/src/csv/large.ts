// 大規模モードの行(16.5): サーバの DuckDB に、見えている範囲のページ(500 行)と前後1ページを問い合わせる。
// 条件を変えたら、新しい結果が届くまでは前の結果を出しておく(表が一瞬空になって位置を見失わないように)
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/http';
import type { CsvMatches } from '../protocol/CsvMatches';
import type { CsvPage } from '../protocol/CsvPage';
import type { CsvView } from '../protocol/CsvView';

const PAGE = 500;
/** 覚えておくページの数(遠くのページから捨てる) */
const KEEP = 24;

type Pages = { key: string; total: number | null; pages: Map<number, CsvPage>; previous: Map<number, CsvPage> };

export function useLargeRows(enabled: boolean, path: string, v: CsvView, range: [number, number], reload: number) {
  const query = { path, options: v.options, sort: v.sort, filters: v.filters };
  const key = JSON.stringify([query, reload]);
  const [state, setState] = useState<Pages>({ key, total: null, pages: new Map(), previous: new Map() });
  if (state.key !== key) setState({ key, total: state.total, pages: new Map(), previous: state.pages.size ? state.pages : state.previous });
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());

  // 条件が変わったら、問い合わせ済みの印を消す(同じ条件に戻ったときに問い合わせ直す)
  useEffect(() => {
    const set = asked.current;
    return () => set.clear();
  }, [key]);

  const first = Math.floor(range[0] / PAGE);
  const last = Math.floor(range[1] / PAGE);
  useEffect(() => {
    if (!enabled) return;
    const q = JSON.parse(key)[0] as typeof query;
    for (let p = Math.max(0, first - 1); p <= last + 1; p++) {
      if (state.total !== null && state.pages.size > 0 && p * PAGE >= state.total) break;
      const id = `${key}#${p}`;
      if (state.pages.has(p) || asked.current.has(id)) continue;
      asked.current.add(id);
      api.csvQuery({ ...q, offset: p * PAGE, limit: PAGE }).then(
        (page) => {
          setError(null);
          setState((s) => {
            if (s.key !== key) return s;
            const pages = new Map(s.pages).set(p, page);
            // 遠くのページから捨てる
            if (pages.size > KEEP) for (const k of [...pages.keys()].sort((a, b) => Math.abs(b - p) - Math.abs(a - p)).slice(0, pages.size - KEEP)) pages.delete(k);
            return { ...s, total: page.total, pages, previous: new Map() };
          });
        },
        (e: unknown) => {
          asked.current.delete(id);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    }
  }, [enabled, key, first, last, state.pages, state.total]);

  /** pos 番目の行。まだ届いていなければ、前の条件の結果か null */
  const rowAt = (pos: number) => {
    const p = Math.floor(pos / PAGE);
    const page = state.pages.get(p) ?? (state.pages.size === 0 ? state.previous.get(p) : undefined);
    const i = pos % PAGE;
    if (!page || i >= page.rows.length) return null;
    return { row: page.rowNumbers[i]!, cells: page.rows[i]! };
  };

  // 検索(全列の部分一致)。並べ替え・フィルター後の位置で返る
  const searchKey = JSON.stringify([key, v.search]);
  const [found, setFound] = useState<{ key: string; result: CsvMatches } | null>(null);
  useEffect(() => {
    if (!enabled || !v.search) return;
    const ctrl = new AbortController();
    const q = JSON.parse(key)[0] as typeof query;
    api.csvSearch({ ...q, query: v.search }, ctrl.signal).then(
      (result) => setFound({ key: searchKey, result }),
      () => {},
    );
    return () => ctrl.abort();
  }, [enabled, key, searchKey, v.search]);

  return {
    total: state.total,
    rowAt,
    error,
    matches: found?.key === searchKey ? found.result : null,
    /** 元の行番号 n の行の位置(: 行番号) */
    locate: (n: number) => api.csvLocate({ ...query, query: '', row: n }),
  };
}
