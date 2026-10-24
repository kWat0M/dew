//! `/ws/events`: タブとの通知のやり取り。ディレクトリ監視(F4)と、CLI からの表示指示(F10)。
//! タブがないときの表示指示は少しの間だけ予約し、次につないだタブに届ける(14.4)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use dew_protocol::{ClientEvent, EntryKind, MediaKind, ServerEvent};
use futures_util::{SinkExt, StreamExt};
use notify::{RecursiveMode, Watcher};
use tokio::sync::{Notify, mpsc};

use crate::App;
use crate::files::{media_kind, resolve};

/// 変更通知をまとめる時間。書き込み中のファイルで通知が続いても、この間隔で1回にする
const COALESCE: Duration = Duration::from_millis(100);

/// タブがないときの表示指示を持っておく時間(9.1)
const RESERVE_FOR: Duration = Duration::from_secs(120);

/// 接続中のタブと監視中のディレクトリ
pub(crate) struct Hub {
    inner: Mutex<Inner>,
    watcher: Mutex<Watch>,
    /// すべてのタブとの接続を切る合図(`dew rotate-token`)
    kick: Notify,
}

#[derive(Default)]
struct Watch {
    watcher: Option<notify::RecommendedWatcher>,
    dirs: HashSet<PathBuf>,
}

struct Inner {
    next_id: u64,
    tabs: HashMap<u64, Tab>,
    /// タブもライブ描画もなくなった時刻(自動停止の判定用。7.1)
    idle_since: Option<Instant>,
    /// 予約した表示指示(最新の1件)と、予約した時刻
    reserved: Option<(PathBuf, Instant)>,
}

struct Tab {
    tx: mpsc::UnboundedSender<ServerEvent>,
    dirs: HashSet<PathBuf>,
    last_active: Instant,
}

impl Hub {
    pub(crate) fn new() -> Arc<Self> {
        let hub = Arc::new(Self {
            inner: Mutex::new(Inner {
                next_id: 0,
                tabs: HashMap::new(),
                idle_since: Some(Instant::now()),
                reserved: None,
            }),
            watcher: Mutex::default(),
            kick: Notify::new(),
        });
        let (tx, rx) = mpsc::unbounded_channel();
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // ファイルを読んだだけの通知(サムネイル作成など)は変更として扱わない
            if let Ok(ev) = res
                && changes_content(&ev.kind)
            {
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        }) {
            Ok(w) => hub.watcher.lock().unwrap().watcher = Some(w),
            Err(e) => tracing::warn!("ディレクトリを監視できません: {e}"),
        }
        tokio::spawn(forward_changes(Arc::downgrade(&hub), rx));
        hub
    }

    /// 最後に操作したタブに表示指示を送る。届けたら true(7.7)。タブがなければ予約する(14.4)
    pub(crate) fn open(&self, path: &Path) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(tab) = inner.tabs.values().max_by_key(|t| t.last_active) else {
            inner.reserved = Some((path.to_owned(), Instant::now()));
            return false;
        };
        tab.tx.send(open_event(path)).is_ok()
    }

    /// すべてのタブに送る(CSV の読み込みの進捗など)
    pub(crate) fn broadcast(&self, ev: ServerEvent) {
        for tab in self.inner.lock().unwrap().tabs.values() {
            let _ = tab.tx.send(ev.clone());
        }
    }

    /// 次につないだタブで開くよう予約する(前の予約は置き換える)
    pub(crate) fn reserve(&self, path: &Path) {
        self.inner.lock().unwrap().reserved = Some((path.to_owned(), Instant::now()));
    }

    /// タブがなくなってからの時間
    pub(crate) fn idle_for(&self) -> Option<Duration> {
        self.inner.lock().unwrap().idle_since.map(|t| t.elapsed())
    }

    /// タブがない状態の始まりを今にする(activate 中のシェルがある間、自動停止までの時間を数えない)
    pub(crate) fn restart_idle(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.idle_since.is_some() {
            inner.idle_since = Some(Instant::now());
        }
    }

    /// すべてのタブとの接続を切る
    pub(crate) fn disconnect_all(&self) {
        self.kick.notify_waiters();
    }

    fn connect(&self, tx: mpsc::UnboundedSender<ServerEvent>) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        let id = inner.next_id;
        inner.next_id += 1;
        // 予約があれば、つないだタブに届ける(古いものは捨てる)
        if let Some((path, at)) = inner.reserved.take()
            && at.elapsed() < RESERVE_FOR
        {
            let _ = tx.send(open_event(&path));
        }
        inner.tabs.insert(
            id,
            Tab {
                tx,
                dirs: HashSet::new(),
                last_active: Instant::now(),
            },
        );
        inner.idle_since = None;
        id
    }

    /// タブへ送る口
    pub(crate) fn sender(&self, id: u64) -> Option<mpsc::UnboundedSender<ServerEvent>> {
        self.inner
            .lock()
            .unwrap()
            .tabs
            .get(&id)
            .map(|t| t.tx.clone())
    }

    fn disconnect(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.tabs.remove(&id);
        if inner.tabs.is_empty() {
            inner.idle_since = Some(Instant::now());
        }
        self.sync_watches(&inner);
    }

    fn handle(&self, id: u64, ev: ClientEvent, root: &Path) {
        let mut inner = self.inner.lock().unwrap();
        let Some(tab) = inner.tabs.get_mut(&id) else {
            return;
        };
        match ev {
            ClientEvent::Active => tab.last_active = Instant::now(),
            ClientEvent::Watch { dirs } => {
                tab.dirs = dirs
                    .iter()
                    .filter_map(|d| resolve(root, d).ok())
                    .filter(|d| d.is_dir())
                    .collect();
                let watching = tab
                    .dirs
                    .iter()
                    .map(|d| d.to_string_lossy().into_owned())
                    .collect();
                let tx = tab.tx.clone();
                self.sync_watches(&inner);
                // 登録が済んでから一覧を読み直してもらう(登録前の変更を取りこぼさないため)
                let _ = tx.send(ServerEvent::Watching { dirs: watching });
            }
        }
    }

    /// どれかのタブが見ているディレクトリだけを監視する
    fn sync_watches(&self, inner: &Inner) {
        let wanted: HashSet<PathBuf> = inner
            .tabs
            .values()
            .flat_map(|t| t.dirs.iter().cloned())
            .collect();
        let mut guard = self.watcher.lock().unwrap();
        let Watch {
            watcher: Some(w),
            dirs,
        } = &mut *guard
        else {
            return;
        };
        for d in dirs.difference(&wanted) {
            let _ = w.unwatch(d);
        }
        for d in wanted.difference(dirs) {
            if let Err(e) = w.watch(d, RecursiveMode::NonRecursive) {
                tracing::warn!(dir = %d.display(), "監視できません: {e}");
            }
        }
        *dirs = wanted;
    }

    fn notify_changed(&self, dir: &Path, name: &str) {
        let inner = self.inner.lock().unwrap();
        for tab in inner.tabs.values().filter(|t| t.dirs.contains(dir)) {
            let _ = tab.tx.send(ServerEvent::DirChanged {
                dir: dir.to_string_lossy().into_owned(),
                name: name.to_owned(),
            });
        }
    }
}

fn open_event(path: &Path) -> ServerEvent {
    let kind = if path.is_dir() {
        EntryKind::Dir
    } else {
        EntryKind::File
    };
    ServerEvent::Open {
        path: path.to_string_lossy().into_owned(),
        kind,
        media: if kind == EntryKind::Dir {
            MediaKind::Other
        } else {
            media_kind(&path.to_string_lossy())
        },
    }
}

fn changes_content(kind: &notify::EventKind) -> bool {
    use notify::EventKind;
    use notify::event::ModifyKind;
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(m) => !matches!(m, ModifyKind::Metadata(_)),
        _ => false,
    }
}

/// inotify の通知を少しまとめてからタブに送る
async fn forward_changes(hub: std::sync::Weak<Hub>, mut rx: mpsc::UnboundedReceiver<PathBuf>) {
    while let Some(first) = rx.recv().await {
        let mut changed = HashSet::from([first]);
        let deadline = tokio::time::Instant::now() + COALESCE;
        while let Ok(Some(p)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            changed.insert(p);
        }
        let Some(hub) = hub.upgrade() else { return };
        for p in changed {
            if let (Some(dir), Some(name)) = (p.parent(), p.file_name()) {
                hub.notify_changed(dir, &name.to_string_lossy());
            }
        }
    }
}

/// `GET /ws/events`
pub(crate) async fn ws(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // 他のサイトのページから開かれないよう、Origin がこのサーバ自身であることを確かめる
    if !same_origin(&headers) {
        return (StatusCode::FORBIDDEN, "Origin が一致しません").into_response();
    }
    upgrade.on_upgrade(move |socket| session(app, socket))
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true; // ブラウザ以外(CLI やテスト)は Origin を付けない
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        == Some(host)
}

async fn session(app: Arc<App>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = app.hub.connect(tx);
    let send = async {
        while let Some(ev) = rx.recv().await {
            let text = serde_json::to_string(&ev).expect("通知を JSON にできません");
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    };
    // ライブ描画のウィンドウの一覧を、つないだときと変わったときに送る
    let tx_live = app.hub.sender(id);
    let mut list = app.live_windows.list.subscribe();
    let live = async move {
        loop {
            let windows = list.borrow_and_update().clone();
            if let Some(tx) = &tx_live {
                let _ = tx.send(ServerEvent::LiveWindows { windows });
            }
            if list.changed().await.is_err() {
                return;
            }
        }
    };
    let recv = async {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(t) => match serde_json::from_str::<ClientEvent>(&t) {
                    Ok(ev) => app.hub.handle(id, ev, &app.root),
                    Err(e) => tracing::warn!("タブからの通知を読めません: {e}"),
                },
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    tokio::select! {
        _ = send => {}
        _ = recv => {}
        _ = live => {}
        _ = app.hub.kick.notified() => {}
    }
    app.hub.disconnect(id);
}
