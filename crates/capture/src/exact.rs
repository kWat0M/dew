//! 精度モード(L3、`dew run --exact`)の受け口。アプリに入れたフック(python/dew_hooks)が、cv2.imshow に
//! 渡された配列を可逆の PNG にして Unix ソケットで送ってくる。窓の名前ごとにウィンドウとして配り、
//! ブラウザの入力モードのキーを waitKey へ返す(ADR 0017)
//!
//! 1通は [ヘッダの長さ 4 バイト(ビッグエンディアン)][JSON のヘッダ][中身(ヘッダの size バイト)]。
//! アプリ → dew: `frame`(name, w, h と PNG)、`destroy`(name)、`destroy_all`。dew → アプリ: `key`(key)、`close`(name)

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;
use bytes::Bytes;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::{broadcast, mpsc};

use crate::stream::{Frame, now_us};

/// 精度モードのウィンドウの ID はここから振る(X のウィンドウ ID と重ならないように。X の ID は 2^29 未満)
pub const FIRST_ID: u32 = 0x4000_0000;

pub fn is_exact(id: u32) -> bool {
    id >= FIRST_ID
}

/// 窓の情報と、これまでの最後の画像と、これからの画像の受け口
pub type Subscription = (
    ExactWindow,
    Option<Arc<Frame>>,
    broadcast::Receiver<Arc<Frame>>,
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactWindow {
    pub id: u32,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub enum ExactEvent {
    Changed(ExactWindow),
    Closed(u32),
}

struct Entry {
    info: ExactWindow,
    latest: Option<Arc<Frame>>,
    tx: broadcast::Sender<Arc<Frame>>,
    /// そのアプリへの送り口
    conn: mpsc::UnboundedSender<Value>,
}

pub struct ExactHub {
    windows: Mutex<HashMap<u32, Entry>>,
    next_id: AtomicU32,
    events: mpsc::UnboundedSender<ExactEvent>,
}

impl ExactHub {
    /// `path` で待ち受けを始める。ウィンドウの出入りは `events` に知らせる
    pub fn start(
        path: &Path,
        events: mpsc::UnboundedSender<ExactEvent>,
    ) -> anyhow::Result<Arc<Self>> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)
            .with_context(|| format!("{} で待ち受けられません", path.display()))?;
        let hub = Arc::new(Self {
            windows: Mutex::default(),
            next_id: AtomicU32::new(FIRST_ID),
            events,
        });
        let me = Arc::downgrade(&hub);
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let Some(hub) = me.upgrade() else { return };
                tokio::spawn(async move {
                    if let Err(e) = hub.serve(sock).await {
                        tracing::debug!("精度モードの接続が終わりました: {e:#}");
                    }
                });
            }
        });
        Ok(hub)
    }

    /// これまでの最後の画像と、これからの画像の受け口
    pub fn subscribe(&self, id: u32) -> Option<Subscription> {
        let ws = self.windows.lock().unwrap();
        let e = ws.get(&id)?;
        Some((e.info.clone(), e.latest.clone(), e.tx.subscribe()))
    }

    pub fn window(&self, id: u32) -> Option<ExactWindow> {
        self.windows
            .lock()
            .unwrap()
            .get(&id)
            .map(|e| e.info.clone())
    }

    /// ブラウザの入力モードで押したキー(KeyboardEvent.key)を、waitKey が返すコードにして送る
    pub fn key(&self, id: u32, key: &str) {
        let Some(code) = key_code(key) else { return };
        if let Some(e) = self.windows.lock().unwrap().get(&id) {
            let _ = e.conn.send(json!({ "t": "key", "key": code }));
        }
    }

    /// キャンバスで閉じた。アプリの getWindowProperty(WND_PROP_VISIBLE)が 0 を返すようにする
    pub fn close(&self, id: u32) {
        if let Some(e) = self.windows.lock().unwrap().remove(&id) {
            let _ = e.conn.send(json!({ "t": "close", "name": e.info.title }));
            let _ = self.events.send(ExactEvent::Closed(id));
        }
    }

    async fn serve(self: Arc<Self>, sock: tokio::net::UnixStream) -> anyhow::Result<()> {
        let (mut rd, mut wr) = sock.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let head = serde_json::to_vec(&msg).unwrap_or_default();
                let mut out = (head.len() as u32).to_be_bytes().to_vec();
                out.extend(head);
                if wr.write_all(&out).await.is_err() {
                    return;
                }
            }
        });
        // この接続(アプリ)の窓の名前と ID
        let mut names: HashMap<String, u32> = HashMap::new();
        let result = async {
            loop {
                let n = rd.read_u32().await? as usize;
                let mut head = vec![0; n];
                rd.read_exact(&mut head).await?;
                let head: Value = serde_json::from_slice(&head)?;
                let size = head["size"].as_u64().unwrap_or(0) as usize;
                let mut body = vec![0; size];
                rd.read_exact(&mut body).await?;
                let name = head["name"].as_str().unwrap_or("").to_owned();
                match head["t"].as_str() {
                    Some("frame") => {
                        let (w, h) = (
                            head["w"].as_u64().unwrap_or(0) as u32,
                            head["h"].as_u64().unwrap_or(0) as u32,
                        );
                        self.frame(&mut names, &name, w, h, body.into(), &tx);
                    }
                    Some("destroy") => {
                        if let Some(id) = names.remove(&name) {
                            self.remove(id);
                        }
                    }
                    Some("destroy_all") => {
                        for (_, id) in names.drain() {
                            self.remove(id);
                        }
                    }
                    _ => {}
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        }
        .await;
        // アプリが終わったら、その窓は全部閉じる
        for (_, id) in names {
            self.remove(id);
        }
        result
    }

    fn frame(
        &self,
        names: &mut HashMap<String, u32>,
        name: &str,
        width: u32,
        height: u32,
        png: Bytes,
        conn: &mpsc::UnboundedSender<Value>,
    ) {
        let frame = Arc::new(Frame {
            key: true,
            timestamp_us: now_us(),
            data: png,
        });
        let mut ws = self.windows.lock().unwrap();
        // キャンバスで閉じた窓に、アプリがまた描いたときは、新しいウィンドウとして出し直す
        let id = match names.get(name) {
            Some(&id) if ws.contains_key(&id) => id,
            _ => {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                names.insert(name.to_owned(), id);
                let info = ExactWindow {
                    id,
                    title: name.to_owned(),
                    width,
                    height,
                };
                ws.insert(
                    id,
                    Entry {
                        info: info.clone(),
                        latest: None,
                        tx: broadcast::channel(16).0,
                        conn: conn.clone(),
                    },
                );
                let _ = self.events.send(ExactEvent::Changed(info));
                id
            }
        };
        let e = ws.get_mut(&id).expect("いま入れた");
        if (e.info.width, e.info.height) != (width, height) {
            e.info.width = width;
            e.info.height = height;
            let _ = self.events.send(ExactEvent::Changed(e.info.clone()));
        }
        e.latest = Some(frame.clone());
        let _ = e.tx.send(frame);
    }

    fn remove(&self, id: u32) {
        if self.windows.lock().unwrap().remove(&id).is_some() {
            let _ = self.events.send(ExactEvent::Closed(id));
        }
    }
}

/// KeyboardEvent.key を、OpenCV(GTK 版)の waitKeyEx が返すコードにする。Enter・Esc などは ASCII、
/// 文字はその文字のコード、矢印などは X の keysym
pub fn key_code(key: &str) -> Option<u32> {
    match key {
        "Enter" => Some(13),
        "Escape" => Some(27),
        "Backspace" => Some(8),
        "Tab" => Some(9),
        _ => crate::input::keysym(key),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_codes_match_opencv() {
        assert_eq!(key_code("a"), Some(97));
        assert_eq!(key_code("A"), Some(65));
        assert_eq!(key_code("Escape"), Some(27));
        assert_eq!(key_code("Enter"), Some(13));
        assert_eq!(key_code("ArrowLeft"), Some(0xff51));
    }

    /// フックと同じ形で送ると、ウィンドウが出て画像が配られ、キーが返り、切れると閉じる
    #[tokio::test]
    async fn frames_keys_and_close() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exact.sock");
        let (tx, mut events) = mpsc::unbounded_channel();
        let hub = ExactHub::start(&path, tx).unwrap();
        let mut app = tokio::net::UnixStream::connect(&path).await.unwrap();
        let send = |head: Value, body: &[u8]| {
            let h = serde_json::to_vec(&head).unwrap();
            let mut out = (h.len() as u32).to_be_bytes().to_vec();
            out.extend(h);
            out.extend_from_slice(body);
            out
        };
        app.write_all(&send(
            json!({"t":"frame","name":"img","w":2,"h":1,"size":3}),
            b"png",
        ))
        .await
        .unwrap();
        let ExactEvent::Changed(w) = events.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!((w.title.as_str(), w.width, w.height), ("img", 2, 1));
        assert!(is_exact(w.id));
        let (_, latest, _) = hub.subscribe(w.id).unwrap();
        assert_eq!(&latest.unwrap().data[..], b"png");

        hub.key(w.id, "q");
        let n = app.read_u32().await.unwrap() as usize;
        let mut head = vec![0; n];
        app.read_exact(&mut head).await.unwrap();
        let msg: Value = serde_json::from_slice(&head).unwrap();
        assert_eq!(msg, json!({"t":"key","key":113}));

        drop(app);
        assert!(matches!(events.recv().await.unwrap(), ExactEvent::Closed(id) if id == w.id));
        assert!(hub.window(w.id).is_none());
    }
}
