//! ライブ描画(フェーズ3)の API: セッションの作成、ウィンドウの一覧、ウィンドウごとの映像

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use dew_capture::audio::{self, Audio};
use dew_capture::encoder::Encoder;
use dew_capture::input::Injector;
use dew_capture::monitor::{self, WindowEvent, WindowInfo};
use dew_capture::pulse::{self, Cli};
use dew_capture::session::Session;
use dew_capture::stream::{Frame, Stream};
use dew_protocol::{LiveAudioConfig, LiveConfig, LiveInput, LiveSession, LiveWindow};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc, watch};

use crate::App;
use crate::files::ApiError;

/// 映っているウィンドウと、その映像
pub(crate) struct Live {
    windows: Mutex<HashMap<u32, (WindowInfo, Arc<Stream>)>>,
    /// 一覧の変化(タブへ知らせる)
    pub list: watch::Sender<Vec<LiveWindow>>,
    /// セッション音声
    audio: Mutex<Option<Arc<Audio>>>,
    /// アプリ(ウィンドウの `_NET_WM_PID`)ごとの音。同じアプリのウィンドウは同じ音を共有する(7.6、ADR 0013)
    apps: Mutex<HashMap<u32, Arc<Audio>>>,
    /// 音の振り分け(`route`)のタスク
    router: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 入力モードのキー・マウスの注入
    input: Mutex<Option<Injector>>,
}

impl Live {
    pub(crate) fn new() -> Self {
        Self {
            windows: Mutex::default(),
            list: watch::channel(Vec::new()).0,
            audio: Mutex::default(),
            apps: Mutex::default(),
            router: Mutex::default(),
            input: Mutex::default(),
        }
    }

    fn publish(&self) {
        let apps = self.apps.lock().unwrap();
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
                audio: w.pid.is_some_and(|p| apps.contains_key(&p)),
            })
            .collect();
        drop(apps);
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
                        (old.x, old.y, old.width, old.height)
                            != (info.x, info.y, info.width, info.height)
                    });
                    if restart {
                        // 位置か大きさが変わったら取り込みを作り直す(x11grab は始めたときの範囲を取り込むため)
                        match Stream::start(display, &info) {
                            Ok(s) => {
                                // 古い取り込みは止める(見ている側は ended を見て新しい映像へ移る)
                                if let Some((_, old)) = ws.insert(info.id, (info, s)) {
                                    old.stop();
                                }
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
        if let Some(r) = self.router.lock().unwrap().take() {
            r.abort();
        }
        if let Some(a) = self.audio.lock().unwrap().take() {
            a.stop();
        }
        for (_, a) in self.apps.lock().unwrap().drain() {
            a.stop();
        }
        self.input.lock().unwrap().take();
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
        // NVENC が使えるかを先に確かめておく(最初のウィンドウの取り込みを待たせないように。ADR 0014)
        let _ = tokio::task::spawn_blocking(Encoder::current).await;
        let (tx, rx) = mpsc::unbounded_channel();
        monitor::spawn(s.display, tx).map_err(|e| ApiError::Internal(format!("{e:#}")))?;
        tokio::spawn(app.live_windows.clone().follow(s.display, rx));
        match Injector::new(s.display) {
            Ok(i) => *app.live_windows.input.lock().unwrap() = Some(i),
            Err(e) => tracing::warn!("入力を注入できません: {e:#}"),
        }
        match Audio::start(&s.pulse_socket, Audio::SESSION_SINK) {
            Ok(a) => *app.live_windows.audio.lock().unwrap() = Some(a),
            Err(e) => tracing::warn!("音声を取り込めません: {e:#}"),
        }
        let router = tokio::spawn(
            app.live_windows
                .clone()
                .route(Cli::new(s.pulse_cli.clone()), s.pulse_socket.clone()),
        );
        *app.live_windows.router.lock().unwrap() = Some(router);
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
    let live = app.live_windows.clone();
    upgrade.on_upgrade(move |socket| async move {
        let (mut sink, mut stream_in) = socket.split();
        let window = info.id;
        // 大きさが変わって取り込みが作り直されたら、同じ接続のまま新しい映像を送る(設定から送り直す)
        let video = async {
            let (mut info, mut stream) = (info, stream);
            while send_video(&mut sink, &info, &stream).await {
                match live.next_stream(window, &stream).await {
                    Some((i, s)) => (info, stream) = (i, s),
                    None => return,
                }
            }
        };
        // 入力モードのキー・マウスを受け取って注入する(L6)
        let input = async {
            while let Some(Ok(Message::Text(t))) = stream_in.next().await {
                match serde_json::from_str::<LiveInput>(&t) {
                    Ok(ev) => live.inject(window, ev),
                    Err(e) => tracing::warn!("入力を読めません: {e}"),
                }
            }
        };
        tokio::select! {
            _ = video => {}
            _ = input => {}
        }
        live.inject(window, LiveInput::Release);
    })
}

impl Live {
    /// アプリの音を、そのアプリのウィンドウの音として振り分け続ける(7.6、ADR 0013)。音のストリームのプロセスが
    /// ウィンドウの `_NET_WM_PID` そのものかその子孫なら、そのアプリ用の出力先へ移して別に取り込む。
    /// 結びつかない音は既定の出力先(セッション音声)のまま
    async fn route(self: Arc<Self>, cli: Cli, pulse_socket: std::path::PathBuf) {
        let cli = Arc::new(cli);
        loop {
            let me = self.clone();
            let (cli2, socket) = (cli.clone(), pulse_socket.clone());
            let changed = tokio::task::spawn_blocking(move || me.route_once(&cli2, &socket))
                .await
                .unwrap_or(Ok(false));
            match changed {
                Ok(true) => self.publish(),
                Ok(false) => {}
                Err(e) => tracing::debug!("音を振り分けられません: {e:#}"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    /// 1回分の振り分け。ウィンドウの音の有無が変わったら true
    fn route_once(&self, cli: &Cli, pulse_socket: &std::path::Path) -> anyhow::Result<bool> {
        let pids: Vec<u32> = {
            let ws = self.windows.lock().unwrap();
            let mut v: Vec<u32> = ws.values().filter_map(|(w, _)| w.pid).collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let mut changed = false;
        for input in cli.sink_inputs()? {
            let Some(owner) = input
                .pid
                .and_then(|p| pids.iter().copied().find(|&w| pulse::descends(p, w)))
            else {
                continue;
            };
            let sink = format!("dew_p{owner}");
            if let Entry::Vacant(e) = self.apps.lock().unwrap().entry(owner) {
                cli.add_sink(&sink)?;
                e.insert(Audio::start(pulse_socket, &sink)?);
                changed = true;
            }
            if input.sink != sink {
                cli.move_input(input.index, &sink)?;
            }
        }
        // ウィンドウがなくなったアプリの出力先を消す(残っていた音はセッション音声へ戻る)
        let gone: Vec<(u32, Arc<Audio>)> = {
            let mut apps = self.apps.lock().unwrap();
            let ids: Vec<u32> = apps.keys().copied().filter(|p| !pids.contains(p)).collect();
            ids.into_iter()
                .filter_map(|p| apps.remove(&p).map(|a| (p, a)))
                .collect()
        };
        for (pid, audio) in gone {
            audio.stop();
            cli.remove_sink(&format!("dew_p{pid}"))?;
            changed = true;
        }
        Ok(changed)
    }

    /// `old` に代わる映像。作り直しの途中で古い方が先に終わることがあるので、少し待つ
    async fn next_stream(&self, id: u32, old: &Arc<Stream>) -> Option<(WindowInfo, Arc<Stream>)> {
        for _ in 0..20 {
            match self.stream(id) {
                Some((i, s)) if !Arc::ptr_eq(&s, old) => return Some((i, s)),
                Some(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                None => return None,
            }
        }
        None
    }

    fn inject(&self, window: u32, ev: LiveInput) {
        let mut guard = self.input.lock().unwrap();
        let Some(inj) = guard.as_mut() else { return };
        let clamp = |v: i32| v.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        let r = match ev {
            LiveInput::Key { key, down } => inj.key(window, &key, down),
            LiveInput::Move { x, y } => inj.motion(window, clamp(x), clamp(y)),
            LiveInput::Button { button, down, x, y } => {
                inj.button(window, button, down, clamp(x), clamp(y))
            }
            LiveInput::Release => inj.release_all(),
            LiveInput::Resize { width, height } => inj.resize(window, width, height),
            LiveInput::Close => inj.close(window),
        };
        if let Err(e) = r {
            tracing::warn!("入力を注入できません: {e:#}");
        }
    }
}

type Sink = futures_util::stream::SplitSink<WebSocket, Message>;

/// 映像を送る。映像が終わったら true、接続が切れたら false を返す
async fn send_video(socket: &mut Sink, info: &WindowInfo, stream: &Stream) -> bool {
    tokio::select! {
        sent = send_frames(socket, info, stream) => sent,
        _ = stream.ended() => true,
    }
}

async fn send_frames(socket: &mut Sink, info: &WindowInfo, stream: &Stream) -> bool {
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
                Err(_) => return true,
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
        return false;
    }
    for f in pending {
        if socket.send(Message::Binary(encode(&f))).await.is_err() {
            return false;
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
                    return false;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => skipping = true,
            Err(_) => return true,
        }
    }
}

/// `GET /ws/live-audio`: セッション音声(どのウィンドウにも結びつかない音)。最初に復号の設定、続けて Opus のパケット
pub(crate) async fn audio_ws(State(app): State<Arc<App>>, upgrade: WebSocketUpgrade) -> Response {
    let Some(audio) = app.live_windows.audio.lock().unwrap().clone() else {
        return (
            axum::http::StatusCode::NOT_FOUND,
            "ライブ描画のセッションがありません",
        )
            .into_response();
    };
    upgrade.on_upgrade(move |socket| send_audio(socket, audio))
}

/// `GET /ws/live-audio/{window}`: そのウィンドウのアプリの音(7.6、ADR 0013)。形式は `/ws/live-audio` と同じ
pub(crate) async fn window_audio_ws(
    State(app): State<Arc<App>>,
    Path(id): Path<u32>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let live = &app.live_windows;
    let pid = live.stream(id).and_then(|(info, _)| info.pid);
    let Some(audio) = pid.and_then(|p| live.apps.lock().unwrap().get(&p).cloned()) else {
        return (
            axum::http::StatusCode::NOT_FOUND,
            "そのウィンドウの音はありません",
        )
            .into_response();
    };
    upgrade.on_upgrade(move |socket| send_audio(socket, audio))
}

async fn send_audio(mut socket: WebSocket, audio: Arc<Audio>) {
    {
        let config = LiveAudioConfig {
            codec: "opus".into(),
            sample_rate: audio::SAMPLE_RATE,
            number_of_channels: audio::CHANNELS,
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
        let mut rx = audio.subscribe();
        loop {
            match rx.recv().await {
                Ok(p) => {
                    let mut out = Vec::with_capacity(8 + p.data.len());
                    out.extend_from_slice(&p.timestamp_us.to_be_bytes());
                    out.extend_from_slice(&p.data);
                    if socket.send(Message::Binary(out.into())).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return,
            }
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
