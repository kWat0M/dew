// CSV の表(16章)。最初に CSV を開いたときに読み込むチャンク(15.6)。
// 状態(並べ替え・フィルター・列の表示と幅)は TanStack Table、行と列の仮想スクロールは TanStack Virtual。
// 小規模モードはブラウザで全件を並べ替え・絞り込み、大規模モードはサーバの DuckDB からページを受け取る(16.1)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, ApiError } from '../api/http';
import type { Events } from '../api/events';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { isLeaveKey, KeySequence, leavesInput } from '../keys';
import { csvKeys, type CsvAction } from './keys';
import type { CsvColumn } from '../protocol/CsvColumn';
import type { CsvColumnView } from '../protocol/CsvColumnView';
import type { CsvFilter } from '../protocol/CsvFilter';
import type { CsvSchema } from '../protocol/CsvSchema';
import type { CsvView as View } from '../protocol/CsvView';
import { useKeys } from '../useKeys';
import { useStable } from '../useStable';
import { compareKeys, invalidValue, matches, searchHit, sortKey, type SortKey } from './compare';
import { FilterDialog, InspectorDialog, JumpDialog, RenameDialog, RulesDialog, SettingsDialog } from './CsvDialogs';
import { columnLetter, count, csvLine, defaultWidth, display, isNumeric, stepDecimals } from './format';
import { useLargeRows } from './large';
import './Csv.css';

/** 1行の高さと、ヘッダー・行番号の列の大きさ(px) */
const ROW = 28;
const HEAD = 32;
const ROWNUM = 64;
/** これより列が多いときだけ、列も仮想化する(16.3) */
const VIRTUAL_COLS = 50;
/** 検索で一致を数える上限(これより多ければ「+」を付ける) */
const MAX_MATCHES = 100_000;

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
});

/** 表の1行(小規模モードの全セルのうちの行番号。0 から) */
type R = { i: number };

export const EMPTY_VIEW: View = { options: {}, sort: [], filters: [], search: '', columns: [], marks: [], rules: [], cell: [0, 0], scroll: [0, 0] };

const keymap = new KeySequence(csvKeys);

type Dialog =
  | { kind: 'filter'; col: number }
  | { kind: 'rename'; col: number }
  | { kind: 'jump' }
  | { kind: 'inspect'; text: string }
  | { kind: 'rules' }
  | { kind: 'settings' };

type Props = {
  id: number;
  path: string;
  events: Events;
  inputMode: boolean;
  onExitInput: () => void;
  onMessage: (m: string) => void;
  /** 選んでいるセルなどを入力モードの外から操作するとき(マウス)は、入力モードに入る */
  onEnterInput: () => void;
  /** 操作パネルから操作を実行する入口を渡す(閉じるときは null) */
  onRegister: (run: ((a: CsvAction) => void) | null) => void;
};

/** 読み込んだもの。小規模モードなら全セル(列ごと) */
type Loaded = { schema: CsvSchema; cols: (string | null)[][] | null };

export default function CsvView({ id, path, events, inputMode, onExitInput, onMessage, onEnterInput, onRegister }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [view, setViewState] = useState<View | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [reload, setReload] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [searching, setSearching] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  /** 選んだセルを見える位置へ動かす回数(キーで動かしたとき。マウスで選んだときは動かさない) */
  const [reveal, setReveal] = useState(0);

  // 表示設定を読んでから、その読み方(文字コードなど)で表を読む(16.6)
  useEffect(() => {
    let alive = true;
    api.csvView(path).then(
      (v) => alive && setViewState(v ?? EMPTY_VIEW),
      () => alive && setViewState(EMPTY_VIEW),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  const optionsKey = JSON.stringify(view?.options ?? null);
  useEffect(() => {
    const options = JSON.parse(optionsKey) as View['options'] | null;
    if (!options) return;
    let alive = true;
    (async () => {
      const schema = await api.csvSchema(path, options);
      if (!alive) return;
      if (schema.mode === 'large' && !schema.ready) {
        setProgress((p) => p ?? { done: 0, total: 1 });
        return;
      }
      const cols = schema.mode === 'small' ? (await api.csvRows(path, options)).columns : null;
      if (!alive) return;
      setLoaded({ schema, cols });
      setProgress(null);
      setDeleted(false);
      setError(null);
    })().catch((e: unknown) => {
      if (!alive) return;
      // 書き換えを見て読み直したら、なくなっていた: 最後の内容を残す(15.4)
      if (reload > 0 && e instanceof ApiError && (e.status === 404 || e.status === 403)) setDeleted(true);
      else setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
    };
  }, [path, optionsKey, reload]);

  // 大規模モードの読み込みの進捗(16.5)。済んだら読み直す
  useEffect(
    () =>
      events.subscribe((ev) => {
        if (ev.type !== 'csvProgress' || ev.path !== path) return;
        if (ev.error) return setError(ev.error);
        if (ev.finished) setReload((n) => n + 1);
        else setProgress({ done: ev.done, total: ev.total });
      }),
    [events, path],
  );
  // ウィンドウを閉じたら、読み込み中の大規模モードを止める
  useEffect(() => () => api.csvCancel(path), [path]);

  // ファイルの変更を監視する(15.4)。変わったら表示設定を保ったまま読み直す
  useEffect(() => {
    const owner = `csv-${id}`;
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const name = basename(path);
    events.watch([dir], owner);
    const off = events.subscribe((ev) => {
      if (ev.type === 'dirChanged' && ev.dir === dir && ev.name === name) setReload((n) => n + 1);
    });
    return () => {
      off();
      events.watch([], owner);
    };
  }, [events, id, path]);

  /** 表示設定を変える。変えたものはサーバにも置く(タブを読み直しても戻すため。16.6) */
  const [changed, setChanged] = useState(0);
  const setView = (f: (v: View) => View) => {
    setViewState((v) => (v ? f(v) : v));
    setChanged((n) => n + 1);
  };
  useEffect(() => {
    if (changed && view) api.saveCsvView(path, view);
  }, [changed, view, path]);

  const schema = loaded?.schema ?? null;
  const columns = useMemo(() => schema?.columns ?? [], [schema]);
  const small = loaded?.cols ?? null;
  const v = view ?? EMPTY_VIEW;
  const colView = (c: number): CsvColumnView | undefined => v.columns.find((x) => x.col === c);
  const updateCol = (c: number, f: (x: CsvColumnView) => CsvColumnView) =>
    setView((w) => {
      const cur = w.columns.find((x) => x.col === c) ?? { col: c, grouping: false, hidden: false, pinned: false };
      return { ...w, columns: [...w.columns.filter((x) => x.col !== c), f(cur)] };
    });

  // ---- TanStack Table: 状態は表示設定から作る ----
  const data = useMemo<R[]>(() => (small ? Array.from({ length: small[0]?.length ?? 0 }, (_, i) => ({ i })) : []), [small]);
  const defs = useMemo(
    () =>
      columns.map(
        (c, i): ColumnDef<typeof features, R> => ({
          id: String(i),
          accessorFn: (r) => sortKey(c.ty, small?.[i]?.[r.i] ?? null),
          sortFn: (a, b, cid) => compareKeys(a.getValue(cid) as SortKey, b.getValue(cid) as SortKey),
          sortUndefined: 'last',
          filterFn: (row, _cid, f: CsvFilter) => matches(c.ty, small?.[i]?.[row.original.i] ?? null, f),
          size: defaultWidth(c),
          minSize: 40,
          maxSize: 2000,
        }),
      ),
    [columns, small],
  );
  const large = schema?.mode === 'large';
  const table = useTable({
    features,
    data,
    columns: defs,
    manualSorting: large,
    manualFiltering: large,
    enableMultiSort: true,
    state: {
      sorting: v.sort.map((s) => ({ id: String(s.col), desc: s.desc })),
      columnFilters: v.filters.map((f) => ({ id: String(f.col), value: f })),
      columnVisibility: Object.fromEntries(v.columns.filter((c) => c.hidden).map((c) => [String(c.col), false])),
      columnSizing: Object.fromEntries(v.columns.filter((c) => c.width !== undefined).map((c) => [String(c.col), c.width!])),
    },
  });
  const visible = table.getVisibleLeafColumns();
  /** 表示する列(元の列番号): 固定した列が先、続けて残りを元の順に */
  const order = useMemo(() => {
    const ids = visible.map((c) => Number(c.id));
    const pinned = ids.filter((c) => v.columns.some((x) => x.col === c && x.pinned));
    return { pinned, rest: ids.filter((c) => !pinned.includes(c)), all: [...pinned, ...ids.filter((c) => !pinned.includes(c))] };
  }, [visible, v.columns]);
  const width = (c: number) => table.getColumn(String(c))?.getSize() ?? 120;
  const pinnedWidth = order.pinned.reduce((s, c) => s + width(c), 0);

  // ---- 行: 小規模はブラウザの並べ替え・絞り込みの結果、大規模はサーバのページ ----
  const smallRows = small ? table.getRowModel().rows : null;
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const largeRows = useLargeRows(large && schema?.ready === true, path, v, range, reload);
  const total = smallRows ? smallRows.length : (largeRows.total ?? 0);
  const allRows = schema?.rows ?? 0;
  /** pos 番目の行(元の行番号と値)。大規模モードで未着なら null */
  const rowAt = (pos: number): { row: number; cells: (string | null)[] } | null => {
    if (smallRows) {
      const r = smallRows[pos]?.original.i;
      return r === undefined ? null : { row: r + 1, cells: small!.map((col) => col[r] ?? null) };
    }
    return largeRows.rowAt(pos);
  };

  // ---- 仮想スクロール ----
  const rowV = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    paddingStart: HEAD,
    overscan: 8,
  });
  const virtualCols = order.rest.length > VIRTUAL_COLS;
  const colV = useVirtualizer({
    horizontal: true,
    count: order.rest.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => width(order.rest[i]!),
    paddingStart: ROWNUM + pinnedWidth,
    overscan: 3,
    enabled: virtualCols,
  });
  // 列幅が変わったら測り直す
  const widthsKey = order.all.map(width).join(',');
  useLayoutEffect(() => colV.measure(), [colV, widthsKey]);
  const vrows = rowV.getVirtualItems();
  const shownCols = virtualCols ? colV.getVirtualItems().map((x) => ({ col: order.rest[x.index]!, start: x.start })) : null;
  const firstRow = vrows[0]?.index ?? 0;
  const lastRow = vrows.at(-1)?.index ?? 0;
  useEffect(() => {
    setRange((r) => (r[0] === firstRow && r[1] === lastRow ? r : [firstRow, lastRow]));
  }, [firstRow, lastRow]);

  // ---- 選択中のセル(位置と元の列番号)----
  const [pos, colRaw] = v.cell;
  const row = Math.max(0, Math.min(total - 1, pos));
  const col = order.all.includes(colRaw) ? colRaw : (order.all[0] ?? 0);
  const select = (r: number, c: number, show = true) => {
    if (show) setReveal((n) => n + 1);
    setView((w) => ({ ...w, cell: [Math.max(0, Math.min(Math.max(0, total - 1), r)), c] }));
  };
  // キーで動かしたら、選択中のセルが見えるようにスクロールする(16.3)。固定した列とヘッダーの下に隠れないように
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s || !reveal) return;
    const top = HEAD + row * ROW;
    if (top < s.scrollTop + HEAD) s.scrollTop = top - HEAD;
    else if (top + ROW > s.scrollTop + s.clientHeight) s.scrollTop = top + ROW - s.clientHeight;
    if (!order.pinned.includes(col)) {
      const i = order.rest.indexOf(col);
      const left = ROWNUM + pinnedWidth + order.rest.slice(0, i).reduce((a, c) => a + width(c), 0);
      const sticky = ROWNUM + pinnedWidth;
      if (left < s.scrollLeft + sticky) s.scrollLeft = left - sticky;
      else if (left + width(col) > s.scrollLeft + s.clientWidth) s.scrollLeft = left + width(col) - s.clientWidth;
    }
    // 動かしたときだけ(スクロールしただけで選択中のセルへ引き戻さない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  // 再読み込みのあとのスクロール位置を戻す(16.6)。最初に表が出たときだけ
  const restored = useRef(false);
  useLayoutEffect(() => {
    const s = scroller.current;
    if (restored.current || !s || !loaded || !view) return;
    restored.current = true;
    s.scrollTop = view.scroll[0];
    s.scrollLeft = view.scroll[1];
  });
  const scrollTimer = useRef<number | null>(null);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => setView((w) => ({ ...w, scroll: [t.scrollTop, t.scrollLeft] })), 300);
  };

  // ---- 検索(16.4): 一致したセルを強調し、n / N で順に移る ----
  const smallMatches = useMemo(() => {
    if (!smallRows || !v.search) return null;
    const out: [number, number][] = [];
    for (let p = 0; p < smallRows.length && out.length <= MAX_MATCHES; p++) {
      const r = smallRows[p]!.original.i;
      for (const c of order.all) if (searchHit(small![c]?.[r] ?? null, v.search)) out.push([p, c]);
    }
    return out;
  }, [smallRows, small, v.search, order.all]);
  // 大規模モードの一致は全列なので、隠した列のものは除く
  const largeFound = useMemo(
    () => (largeRows.matches ? { matches: largeRows.matches.matches.filter(([, c]) => order.all.includes(c)), truncated: largeRows.matches.truncated } : null),
    [largeRows.matches, order.all],
  );
  const found = smallMatches ? { matches: smallMatches.slice(0, MAX_MATCHES), truncated: smallMatches.length > MAX_MATCHES } : largeFound;
  const goMatch = (dir: 1 | -1, from = matchIndex) => {
    const list = found?.matches ?? [];
    if (!list.length) return onMessage(ja.csv.searchCount(0, 0, false));
    const i = (((from + dir) % list.length) + list.length) % list.length;
    setMatchIndex(i);
    select(list[i]![0], list[i]![1]);
  };
  // 検索語を確定したら、最初の一致へ
  const [pendingFirst, setPendingFirst] = useState(false);
  if (pendingFirst && found) {
    setPendingFirst(false);
    const first = found.matches[0];
    if (first) {
      setMatchIndex(0);
      select(first[0], first[1]);
    }
  }

  // ---- 操作 ----
  const column = (c: number): CsvColumn | undefined => columns[c];
  const pageRows = () => Math.max(1, Math.floor(((scroller.current?.clientHeight ?? 300) - HEAD) / ROW) - 1);
  const copy = (text: string, done: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => onMessage(done),
      () => onMessage(ja.copyFailed),
    );

  /** 操作する。at は対象の列(列の見出しのメニューから。なければ選択中の列) */
  const run = (a: CsvAction, at: number = col) => {
    const col = at;
    const ci = order.all.indexOf(col);
    switch (a.do) {
      case 'move':
        return select(row + a.dr, order.all[Math.max(0, Math.min(order.all.length - 1, ci + a.dc))] ?? col);
      case 'page':
        return select(row + a.dir * (a.half ? Math.ceil(pageRows() / 2) : pageRows()), col);
      case 'pageSide': {
        const s = scroller.current;
        const step = Math.max(1, Math.floor(((s?.clientWidth ?? 600) - ROWNUM - pinnedWidth) / 120));
        return select(row, order.all[Math.max(0, Math.min(order.all.length - 1, ci + a.dir * step))] ?? col);
      }
      case 'top':
        return select(0, col);
      case 'bottom':
        return select(total - 1, col);
      case 'home':
        return select(row, order.all[0] ?? col);
      case 'end':
        return select(row, order.all.at(-1) ?? col);
      case 'jump':
        return setDialog({ kind: 'jump' });
      case 'inspect': {
        const r = rowAt(row);
        return r && setDialog({ kind: 'inspect', text: r.cells[col] ?? '' });
      }
      case 'search':
        // 検索欄を出したまま抜けていたら、欄に戻る
        searchInput.current?.focus();
        return setSearching(true);
      case 'match':
        return goMatch(a.dir);
      case 'sort':
        return setView((w) => {
          const cur = w.sort.find((s) => s.col === col);
          if (a.add) {
            // 次のソートキーとして足す(足してあれば向きを変える)
            if (!cur) return { ...w, sort: [...w.sort, { col, desc: false }] };
            return { ...w, sort: w.sort.map((s) => (s.col === col ? { ...s, desc: !s.desc } : s)) };
          }
          // 昇順 → 降順 → 解除
          if (!cur || w.sort.length > 1) return { ...w, sort: [{ col, desc: cur?.desc === false && w.sort.length === 1 }] };
          return { ...w, sort: cur.desc ? [] : [{ col, desc: true }] };
        });
      case 'filter':
        return setDialog({ kind: 'filter', col });
      case 'clearFilters':
        return setView((w) => ({ ...w, filters: [] }));
      case 'rename':
        return setDialog({ kind: 'rename', col });
      case 'decimals': {
        const c = column(col);
        if (!c || !isNumeric(c)) return onMessage(ja.csv.notNumber);
        return updateCol(col, (x) => ({ ...x, decimals: stepDecimals(c, x.decimals, a.dir) }));
      }
      case 'mark': {
        const r = rowAt(row);
        if (!r) return;
        return setView((w) => ({ ...w, marks: w.marks.includes(r.row) ? w.marks.filter((m) => m !== r.row) : [...w.marks, r.row] }));
      }
      case 'rules':
        return setDialog({ kind: 'rules' });
      case 'hide': {
        if (order.all.length <= 1) return;
        const next = order.all[ci + 1] ?? order.all[ci - 1]!;
        updateCol(col, (x) => ({ ...x, hidden: true }));
        return select(row, next, false);
      }
      case 'showAll':
        return setView((w) => ({ ...w, columns: w.columns.map((x) => ({ ...x, hidden: false })) }));
      case 'pin':
        return updateCol(col, (x) => ({ ...x, pinned: !x.pinned }));
      case 'width':
        return updateCol(col, (x) => ({ ...x, width: Math.round(Math.max(40, Math.min(2000, width(col) * a.f))) }));
      case 'fit':
        return updateCol(col, (x) => ({ ...x, width: fitWidth(col) }));
      case 'copy': {
        const r = rowAt(row);
        if (!r) return;
        if (a.row) return copy(csvLine(r.cells, schema?.delimiter ?? ','), ja.csv.copiedRow);
        const text = r.cells[col] ?? '';
        return copy(text, ja.copied(text));
      }
      case 'settings':
        return setDialog({ kind: 'settings' });
      case 'reset':
        // 読み方の手動設定も含めて、すべて初期状態に(16.6)
        setView(() => EMPTY_VIEW);
        return onMessage(ja.csv.resetDone);
      case 'exit':
        setDialog(null);
        setSearching(false);
        return onExitInput();
    }
  };

  /** 見えている行の値に合わせた列幅(=) */
  const fitWidth = (c: number) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return width(c);
    ctx.font = '14px sans-serif';
    let w = ctx.measureText(colView(c)?.label ?? columns[c]?.name ?? '').width + 40;
    for (let p = firstRow; p <= lastRow; p++) {
      const raw = rowAt(p)?.cells[c];
      if (raw) w = Math.max(w, ctx.measureText(display(columns[c]!, colView(c), raw.split('\n')[0]!)).width + 20);
    }
    return Math.round(Math.max(40, Math.min(800, w)));
  };

  // 操作パネルから(4.4)
  const runFromPanel = useStable((a: CsvAction) => run(a));
  const onRegisterRef = useRef(onRegister);
  useLayoutEffect(() => {
    onRegisterRef.current = onRegister;
  });
  useEffect(() => {
    onRegisterRef.current(runFromPanel);
    return () => onRegisterRef.current(null);
  }, [runFromPanel]);

  useKeys((k, e) => {
    // 小さな画面や検索欄を出したまま抜けていたら、抜けるキーでまずそれを閉じる(1回で1段ずつ戻る)
    if ((dialog || searching) && isLeaveKey(k.key)) {
      e.preventDefault();
      keymap.reset();
      if (dialog) return setDialog(null);
      return setSearching(false);
    }
    // 小さな画面のキーは、その画面が受け持つ
    if (dialog) return;
    const a = keymap.push(k.key);
    if (a === null) return;
    e.preventDefault();
    if (a !== 'pending') run(a);
  }, inputMode);

  // ---- 描画 ----
  const sortIndex = (c: number) => v.sort.findIndex((s) => s.col === c);
  const ruleColor = (cells: (string | null)[]) =>
    v.rules.find((rule) => {
      const c = columns[rule.col];
      return c && invalidValue(c.ty, rule) === null && matches(c.ty, cells[rule.col] ?? null, rule);
    })?.color;
  const current = found?.matches[matchIndex];

  const headerCell = (c: number, style: React.CSSProperties) => {
    const col0 = columns[c]!;
    const cv = colView(c);
    const si = sortIndex(c);
    const sort = si >= 0 ? v.sort[si]! : null;
    return (
      <div
        key={c}
        role="columnheader"
        data-col={c}
        data-pinned={cv?.pinned ? 'true' : undefined}
        aria-sort={sort ? (sort.desc ? 'descending' : 'ascending') : undefined}
        className={`csv-th${cv?.pinned ? ' pinned' : ''}${c === col ? ' current' : ''}${isNumeric(col0) ? ' num' : ''}`}
        style={{ width: width(c), ...style }}
        title={ja.csv.original(col0.name)}
        onClick={(e) => {
          onEnterInput();
          select(row, c, false);
          if (e.shiftKey) setView((w) => ({ ...w, sort: w.sort.some((s) => s.col === c) ? w.sort : [...w.sort, { col: c, desc: false }] }));
        }}
      >
        <span className="csv-th-name">{cv?.label ?? col0.name}</span>
        {sort && (
          <span className="csv-th-sort">
            {sort.desc ? '↓' : '↑'}
            {v.sort.length > 1 ? si + 1 : ''}
          </span>
        )}
        {v.filters.some((f) => f.col === c) && <Icon name="filter" size={14} />}
        <ColumnMenu onPick={(a) => {
          select(row, c, false);
          run(a, c);
        }} numeric={isNumeric(col0)} />
      </div>
    );
  };

  const bodyCell = (r: { row: number; cells: (string | null)[] }, p: number, c: number, style: React.CSSProperties) => {
    const raw = r.cells[c] ?? null;
    const c0 = columns[c]!;
    const hit = v.search !== '' && searchHit(raw, v.search);
    const selected = p === row && c === col;
    return (
      <div
        key={c}
        role="gridcell"
        data-col={c}
        aria-selected={selected}
        data-match={hit ? 'true' : undefined}
        className={`csv-td${isNumeric(c0) ? ' num' : ''}${raw === null ? ' null' : ''}${selected ? ' selected' : ''}${hit ? ' match' : ''}${current && current[0] === p && current[1] === c ? ' current-match' : ''}${colView(c)?.pinned ? ' pinned' : ''}`}
        style={{ width: width(c), ...style }}
        onClick={() => {
          onEnterInput();
          select(p, c, false);
        }}
        onDoubleClick={() => setDialog({ kind: 'inspect', text: raw ?? '' })}
      >
        {raw === null ? '—' : display(c0, colView(c), raw)}
      </div>
    );
  };

  /** 1行分のセル: 固定した列(左に貼り付く)、続けて残りの列(多ければ見えている分だけ) */
  const cellsOf = (make: (c: number, style: React.CSSProperties) => React.ReactNode) => {
    let left = ROWNUM;
    const pinned = order.pinned.map((c) => {
      const el = make(c, { position: 'sticky', left });
      left += width(c);
      return el;
    });
    if (!shownCols) return [...pinned, ...order.rest.map((c) => make(c, {}))];
    const pad = (shownCols[0]?.start ?? ROWNUM + pinnedWidth) - ROWNUM - pinnedWidth;
    return [...pinned, <div key="pad" className="csv-pad" style={{ width: pad }} />, ...shownCols.map(({ col: c }) => make(c, {}))];
  };
  const totalWidth = ROWNUM + order.all.reduce((s, c) => s + width(c), 0);

  if (error && !loaded)
    return (
      <div className="doc-message" role="alert" data-testid="csv-error">
        {error}
      </div>
    );
  if (!loaded || !view)
    return progress ? (
      <div className="csv-progress" data-testid="csv-progress">
        <span>{ja.csv.loading(Math.floor((100 * progress.done) / Math.max(1, progress.total)))}</span>
        <progress max={progress.total} value={progress.done} />
      </div>
    ) : (
      <div className="doc-message">{ja.loading}</div>
    );

  const sel = rowAt(row);
  return (
    <>
      <div
        ref={scroller}
        className="csv-scroll"
        role="grid"
        aria-rowcount={total + 1}
        aria-colcount={order.all.length}
        data-testid="csv-grid"
        onScroll={onScroll}
      >
        <div className="csv-inner" style={{ height: rowV.getTotalSize(), width: totalWidth }}>
          <div className="csv-head" role="row" style={{ width: totalWidth }}>
            <div className="csv-corner" style={{ width: ROWNUM }} />
            {cellsOf(headerCell)}
          </div>
          {vrows.map((x) => {
            const r = rowAt(x.index);
            if (!r)
              return (
                <div key={x.key} className="csv-tr loading" style={{ top: x.start, width: totalWidth }}>
                  <div className="csv-rownum" style={{ width: ROWNUM }} />
                </div>
              );
            const marked = v.marks.includes(r.row);
            const color = ruleColor(r.cells);
            return (
              <div
                key={x.key}
                role="row"
                data-row={r.row}
                data-marked={marked ? 'true' : undefined}
                className={`csv-tr${marked ? ' marked' : ''}${color ? ` rule-${color}` : ''}${x.index === row ? ' current' : ''}`}
                style={{ top: x.start, width: totalWidth }}
              >
                <div role="rowheader" className="csv-rownum" style={{ width: ROWNUM }}>
                  {r.row}
                </div>
                {cellsOf((c, style) => bodyCell(r, x.index, c, style))}
              </div>
            );
          })}
        </div>
      </div>
      {searching && (
        <input
          ref={searchInput}
          className="doc-search csv-search"
          autoFocus
          aria-label={ja.csv.search}
          defaultValue={v.search}
          placeholder={ja.csv.search}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              const query = e.currentTarget.value;
              setSearching(false);
              setView((w) => ({ ...w, search: query }));
              setMatchIndex(0);
              setPendingFirst(true);
            } else if (leavesInput(e.nativeEvent)) e.currentTarget.blur();
            else return;
            e.preventDefault();
          }}
        />
      )}
      {dialog?.kind === 'filter' && (
        <FilterDialog
          column={columns[dialog.col]!}
          label={colView(dialog.col)?.label}
          current={v.filters.find((f) => f.col === dialog.col)}
          onApply={(f) => {
            if (f && invalidValue(columns[dialog.col]!.ty, { ...f, col: dialog.col })) return onMessage(ja.csv.needNumber);
            setView((w) => ({ ...w, filters: [...w.filters.filter((x) => x.col !== dialog.col), ...(f ? [{ ...f, col: dialog.col }] : [])], cell: [0, w.cell[1]] }));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameDialog
          name={columns[dialog.col]!.name}
          label={colView(dialog.col)?.label}
          onApply={(label) => {
            updateCol(dialog.col, (x) => ({ ...x, label: label || undefined }));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'jump' && (
        <JumpDialog
          onApply={async (n) => {
            setDialog(null);
            if (smallRows) {
              const p = smallRows.findIndex((r) => r.original.i === n - 1);
              return p < 0 ? onMessage(ja.csv.noRow(n)) : select(p, col);
            }
            const p = await largeRows.locate(n);
            return p === null ? onMessage(ja.csv.noRow(n)) : select(p, col);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'inspect' && <InspectorDialog text={dialog.text} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rules' && (
        <RulesDialog
          columns={columns}
          rules={v.rules}
          current={col}
          onChange={(rules) => setView((w) => ({ ...w, rules }))}
          onMessage={onMessage}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog
          schema={schema!}
          options={v.options}
          column={columns[col]}
          view={colView(col)}
          onOptions={(options) => setView((w) => ({ ...w, options }))}
          onColumn={(f) => updateCol(col, f)}
          onReset={() => {
            run({ do: 'reset' });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      <footer className="doc-status csv-status" data-testid="csv-status">
        <div className="doc-status-side">
          {deleted && <span className="doc-note error">{ja.csv.deleted}</span>}
          {(error ?? largeRows.error) && (
            <span className="doc-note error" data-testid="csv-error">
              {error ?? largeRows.error}
            </span>
          )}
          <span className="doc-note" data-testid="csv-rows">
            {ja.csv.rows(count(total), count(allRows))}
          </span>
          <span className="doc-note">{ja.csv.cols(count(columns.length))}</span>
          {sel && <span className="doc-note csv-cell-name">{`${columnLetter(col)}${sel.row}`}</span>}
          {v.sort.length > 0 && (
            <span className="doc-note">
              {ja.csv.sortBy}: {v.sort.map((s) => `${colView(s.col)?.label ?? columns[s.col]?.name ?? ''} ${s.desc ? '↓' : '↑'}`).join(', ')}
            </span>
          )}
          {v.search && found && <span className="doc-note">{ja.csv.searchCount(matchIndex, found.matches.length, found.truncated)}</span>}
          {schema!.ragged > 0 && (
            <span className="doc-note error" data-testid="csv-warning">
              {ja.csv.ragged(count(schema!.ragged))}
            </span>
          )}
        </div>
        <div className="doc-status-side end">
          <button type="button" className="icon-button doc-bar-button" title={`${ja.csv.search}(/)`} aria-label={ja.csv.search} onClick={() => run({ do: 'search' })}>
            <Icon name="search" size={18} />
          </button>
          {v.filters.length > 0 && (
            <button type="button" className="icon-button doc-bar-button" title={ja.csv.clearFilters} aria-label={ja.csv.clearFilters} onClick={() => run({ do: 'clearFilters' })}>
              <Icon name="filterOff" size={18} />
            </button>
          )}
          {v.columns.some((c) => c.hidden) && (
            <button type="button" className="icon-button doc-bar-button" title={ja.csv.showHidden} aria-label={ja.csv.showHidden} onClick={() => run({ do: 'showAll' })}>
              <Icon name="visibility" size={18} />
            </button>
          )}
          <button type="button" className="icon-button doc-bar-button" title={`${ja.csv.rules}(M)`} aria-label={ja.csv.rules} onClick={() => run({ do: 'rules' })}>
            <Icon name="palette" size={18} />
          </button>
          <button type="button" className="icon-button doc-bar-button" title={`${ja.csv.settings}(o)`} aria-label={ja.csv.settings} onClick={() => run({ do: 'settings' })}>
            <Icon name="tune" size={18} />
          </button>
          <span className="doc-divider" />
          <span className="doc-note">{ja.encodings[schema!.encoding]}</span>
          <span className="doc-note">{ja.csv.delimiters[schema!.delimiter] ?? schema!.delimiter}</span>
          <span className="doc-note" title={ja.csv.modeTitle(!large)}>
            {large ? ja.csv.large : ja.csv.small}
          </span>
        </div>
      </footer>
    </>
  );
}

/** 列の見出しのメニュー(マウスで列を操作する。説明にキーも書く) */
function ColumnMenu({ onPick, numeric }: { onPick: (a: CsvAction) => void; numeric: boolean }) {
  const C = ja.csv;
  const items: [string, CsvAction][] = [
    [C.sortAsc, { do: 'sort', add: false }],
    [C.sortAdd, { do: 'sort', add: true }],
    [C.filterKey, { do: 'filter' }],
    [C.rename, { do: 'rename' }],
    [C.hide, { do: 'hide' }],
    [C.pin, { do: 'pin' }],
    [C.wider, { do: 'width', f: 1.2 }],
    [C.narrower, { do: 'width', f: 1 / 1.2 }],
    [C.fit, { do: 'fit' }],
    ...(numeric
      ? ([
          [C.moreDecimals, { do: 'decimals', dir: 1 }],
          [C.fewerDecimals, { do: 'decimals', dir: -1 }],
        ] as [string, CsvAction][])
      : []),
  ];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-button small csv-th-menu" title={C.menu} aria-label={C.menu} onClick={(e) => e.stopPropagation()}>
        <Icon name="menu" size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="doc-menu" align="start" sideOffset={4}>
          {items.map(([label, a]) => (
            <DropdownMenu.Item key={label} className="menu-item doc-menu-item" onSelect={() => onPick(a)}>
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
