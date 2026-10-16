//! ライブ描画(フェーズ3)の API: セッションの作成、ウィンドウの一覧、ウィンドウごとの映像

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use dew_capture::monitor::{self, WindowEvent, WindowInfo};
use dew_capture::session::Session;
use dew_capture::stream::{Frame, Stream};
use dew_protocol::{LiveConfig, LiveSession, LiveWindow};
use tokio::sync::{broadcast, mpsc, watch};

use crate::App;
use crate::files::ApiError;

/// 映っているウィンドウと、その映像
pub(crate) struct Live {
    windows: Mutex<HashMap<u32, (WindowInfo, Arc<Stream>)>>,
    /// 一覧の変化(タブへ知らせる)
    pub list: watch::Sender<Vec<LiveWindow>>,
}

impl Live {
    pub(crate) fn new() -> Self {
        Self {
            windows: Mutex::default(),
            list: watch::channel(Vec::new()).0,
        }
    }

    fn publish(&self) {
        let mut list: Vec<LiveWindow> = self
            .windows
            .lock()
            .unwrap()
            .values()
            .map(|(w, _)| LiveWindow {
                id: w.id,
                title: w.title.clone(),
                width: w.width,
                height: w.height,
            })
            .collect();
        list.sort_by_key(|w| w.id);
        self.list.send_replace(list);
    }

    fn stream(&self, id: u32) -> Option<(WindowInfo, Arc<Stream>)> {
        self.windows.lock().unwrap().get(&id).cloned()
    }

    /// ウィンドウの変化を受けて、映像を始める・作り直す・止める
    async fn follow(self: Arc<Self>, display: u32, mut rx: mpsc::UnboundedReceiver<WindowEvent>) {
        while let Some(ev) = rx.recv().await {
            match ev {
                WindowEvent::Changed(info) => {
                    let mut ws = self.windows.lock().unwrap();
                    let restart = ws.get(&info.id).is_none_or(|(old, _)| {
                        (old.width, old.height) != (info.width, info.height)
                    });
                    if restart {
                        // 大きさが変わったら取り込みを作り直す(x11grab は始めたときの大きさで取り込むため)
                        match Stream::start(display, info.id) {
                            Ok(s) => {
                                ws.insert(info.id, (info, s));
                            }
                            Err(e) => tracing::warn!("ウィンドウを取り込めません: {e:#}"),
                        }
                    } else if let Some(entry) = ws.get_mut(&info.id) {
                        entry.0 = info;
                    }
                }
                WindowEvent::Closed(id) => {
                    if let Some((_, s)) = self.windows.lock().unwrap().remove(&id) {
                        s.stop();
                    }
                }
            }
            self.publish();
        }
    }

    pub(crate) fn clear(&self) {
        for (_, (_, s)) in self.windows.lock().unwrap().drain() {
            s.stop();
        }
        self.publish();
    }
}

/// `POST /api/live/session`: セッションがなければ作り、アプリにつなぐ設定を返す(dew run / dew env)
pub(crate) async fn session(State(app): State<Arc<App>>) -> Result<Json<LiveSession>, ApiError> {
    let mut live = app.live.lock().await;
    if live.is_none() {
        let s = Session::start(&app.cache_dir.join("live"))
            .await
            .map_err(|e| ApiError::Internal(format!("{e:#}")))?;
        let (tx, rx) = mpsc::unbounded_channel();
        monitor::spawn(s.display, tx).map_err(|e| ApiError::Internal(format!("{e:#}")))?;
        tokio::spawn(app.live_windows.clone().follow(s.display, rx));
        *live = Some(s);
    }
    let s = live.as_ref().unwrap();
    Ok(Json(LiveSession {
        display: format!(":{}", s.display),
        env: s.env(),
        unset: Session::UNSET.iter().map(|v| (*v).to_owned()).collect(),
    }))
}

/// `GET /ws/live/{id}`: ウィンドウの映像。最初に復号の設定、続けてキーフレーム以降のフレーム
pub(crate) async fn ws(
    State(app): State<Arc<App>>,
    Path(id): Path<u32>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some((info, stream)) = app.live_windows.stream(id) else {
        return (
            axum::http::StatusCode::NOT_FOUND,
            "そのウィンドウはありません",
        )
            .into_response();
    };
    upgrade.on_upgrade(move |socket| send_video(socket, info, stream))
}

async fn send_video(mut socket: WebSocket, info: WindowInfo, stream: Arc<Stream>) {
    let (codec, backlog, mut rx) = stream.subscribe();
    // まだキーフレームが来ていなければ、来るまで待つ
    let mut pending: Vec<Arc<Frame>> = backlog;
    let codec = match codec {
        Some(c) => c,
        None => loop {
            match rx.recv().await {
                Ok(f) if f.key => {
                    pending = vec![f];
                    if let (Some(c), _, _) = stream.subscribe() {
                        break c;
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return,
            }
        },
    };
    let config = LiveConfig {
        codec,
        width: info.width + info.width % 2,
        height: info.height + info.height % 2,
    };
    if socket
        .send(Message::Text(
            serde_json::to_string(&config).unwrap().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    for f in pending {
        if socket.send(Message::Binary(encode(&f))).await.is_err() {
            return;
        }
    }
    // 遅れて取りこぼしたら、次のキーフレームまで飛ばす(遅延を積み上げない。6.1 の 6)
    let mut skipping = false;
    loop {
        match rx.recv().await {
            Ok(f) => {
                if skipping && !f.key {
                    continue;
                }
                skipping = false;
                if socket.send(Message::Binary(encode(&f))).await.is_err() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => skipping = true,
            Err(_) => return,
        }
    }
}

/// [フラグ 1バイト][タイムスタンプ µs 8バイト][H.264 Annex B]
fn encode(f: &Frame) -> axum::body::Bytes {
    let mut out = Vec::with_capacity(9 + f.data.len());
    out.push(u8::from(f.key));
    out.extend_from_slice(&f.timestamp_us.to_be_bytes());
    out.extend_from_slice(&f.data);
    out.into()
}
