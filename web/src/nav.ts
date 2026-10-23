// 画面の移り変わりをブラウザの履歴に載せる(4.5)。戻る・進む(マウスのサイドボタンも)で前の画面・ディレクトリ・文書へ
import { useSyncExternalStore } from 'react';

/** 履歴の1項目が表す場所。dir が null なら Home の初期位置 */
export type Place =
  | { screen: 'home'; dir: string | null }
  | { screen: 'canvas'; focus: number | null; doc?: { win: number; index: number } };

/** history.state に入れるもの。n は履歴の中の位置、load はページを読み込むたびに変わる印 */
type Entry = { place: Place; n: number; load: string };

const HOME = '/home';
const CANVAS = '/canvas';
const TOP_KEY = 'dew.nav.top';

/** 場所の URL。Home はディレクトリのパスを区切りごとに符号化して /home の後ろに付ける */
export function urlOf(p: Place): string {
  if (p.screen === 'canvas') return CANVAS;
  if (p.dir === null) return '/';
  return HOME + p.dir.split('/').map(encodeURIComponent).join('/');
}

/** URL の場所(再読み込み・直接開いたとき)。キャンバスのウィンドウは URL からは決まらない */
export function placeOfUrl(pathname: string): Place {
  if (pathname === CANVAS) return { screen: 'canvas', focus: null };
  if (pathname.startsWith(HOME + '/')) {
    try {
      return { screen: 'home', dir: pathname.slice(HOME.length).split('/').map(decodeURIComponent).join('/') };
    } catch {
      // 符号化が壊れている
    }
  }
  return { screen: 'home', dir: null };
}

function isEntry(s: unknown): s is Entry {
  return typeof s === 'object' && s !== null && 'place' in s && typeof (s as Entry).n === 'number';
}

/** 別の読み込みの項目は、ウィンドウの番号が今のものと合わないので使わない */
function strip(e: Entry, load: string): Place {
  if (e.load === load || e.place.screen === 'home') return e.place;
  return { screen: 'canvas', focus: null };
}

export class Nav {
  private readonly load = Math.random().toString(36).slice(2);
  private n = 0;
  /** 進める最後の位置 */
  private top = 0;
  private listeners = new Set<() => void>();
  private snapshot = { back: false, forward: false };

  /** 読み込んだときの場所。今の項目に印を付け直す */
  start(): Place {
    const s: unknown = history.state;
    const place = isEntry(s) ? strip(s, this.load) : placeOfUrl(location.pathname);
    this.n = isEntry(s) ? s.n : 0;
    this.top = Math.max(this.n, readTop());
    this.write('replace', place);
    return place;
  }

  /** 新しい項目を積む(その先の項目は消える) */
  push(place: Place) {
    this.n++;
    this.top = this.n;
    this.write('push', place);
  }

  /** 今の項目を書き換える */
  replace(place: Place) {
    this.write('replace', place);
  }

  /** 今の項目の場所 */
  current(): Place | null {
    const s: unknown = history.state;
    return isEntry(s) ? s.place : null;
  }

  back() {
    if (this.n > 0) history.back();
  }

  forward() {
    if (this.n < this.top) history.forward();
  }

  /** 戻る・進むで移った先の場所を受け取る */
  onPop(cb: (place: Place) => void): () => void {
    const handler = (e: PopStateEvent) => {
      const s: unknown = e.state;
      if (isEntry(s)) this.n = s.n;
      this.notify();
      cb(isEntry(s) ? strip(s, this.load) : placeOfUrl(location.pathname));
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** 戻れるか・進めるか(このタブで dew の中を動いた分だけ。dew より前のページへは戻らない) */
  state = () => this.snapshot;

  private write(how: 'push' | 'replace', place: Place) {
    const entry: Entry = { place, n: this.n, load: this.load };
    if (how === 'push') history.pushState(entry, '', urlOf(place));
    else history.replaceState(entry, '', urlOf(place));
    try {
      sessionStorage.setItem(TOP_KEY, String(this.top));
    } catch {
      // 覚えられなくても、再読み込みまでは効く
    }
    this.notify();
  }

  private notify() {
    const next = { back: this.n > 0, forward: this.n < this.top };
    if (next.back === this.snapshot.back && next.forward === this.snapshot.forward) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

function readTop(): number {
  try {
    return Number(sessionStorage.getItem(TOP_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** アプリ全体で1つの履歴 */
export const nav = new Nav();

/** 戻れるか・進めるか(ボタンの有効・無効) */
export function useNavState() {
  return useSyncExternalStore(nav.subscribe, nav.state);
}
