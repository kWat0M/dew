// /ws/events のクライアント。切れたら自動で再接続し、見ているディレクトリを送り直す(7.7)。
// サーバが止まっている間も再接続を試み続ける(ページは読み直さないので、キャンバスのウィンドウは残る。14.2)
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';

type Listener = (ev: ServerEvent) => void;
type StateListener = (online: boolean) => void;

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;

export class Events {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private online = true;
  private dirs: string[] = [];
  private retry = RETRY_MIN_MS;
  private closed = false;
  private readonly url: string;

  constructor(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`) {
    this.url = url;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  subscribe(f: Listener): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** つながっているか。最初につなぐまでは true(切れたときだけ false を知らせる) */
  subscribeState(f: StateListener): () => void {
    this.stateListeners.add(f);
    return () => this.stateListeners.delete(f);
  }

  /** 変更を知りたいディレクトリ(前回の指定を置き換える) */
  watch(dirs: string[]) {
    this.dirs = dirs;
    this.send({ type: 'watch', dirs });
  }

  /** ユーザーがこのタブを操作した(dew <ファイル> の送り先を決めるのに使う) */
  active() {
    this.send({ type: 'active' });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  private send(ev: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = RETRY_MIN_MS;
      this.setOnline(true);
      if (this.dirs.length) this.send({ type: 'watch', dirs: this.dirs });
    };
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data as string) as ServerEvent;
      for (const f of this.listeners) f(ev);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.setOnline(false);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
    };
  }

  private setOnline(online: boolean) {
    if (online === this.online) return;
    this.online = online;
    for (const f of this.stateListeners) f(online);
  }
}
