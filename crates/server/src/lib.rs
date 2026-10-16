//! HTTP / WebSocket サーバとファイル API。1ポートに HTTPS で載せる

mod auth;
mod events;
mod files;
mod history;
mod live;
mod media;
mod tls;
mod web;

use std::net::{IpAddr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use axum::Router;
use axum::extract::{Query, Request, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, middleware};
use dew_protocol::{Info, OpenRequest, OpenResponse};
use tokio::sync::Notify;

/// キャッシュの上限(9.1)
const CACHE_LIMIT: u64 = 5 * 1024 * 1024 * 1024;

/// 接続中のタブがない状態がこれだけ続いたら自動で止まる(7.1)
const IDLE_LIMIT: Duration = Duration::from_secs(12 * 3600);

/// 待ち受けポートが使用中のとき、次の番号を試す回数
const PORT_TRIES: u16 = 100;

/// サーバの起動設定
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: IpAddr,
    /// 希望のポート。使用中なら次の空きを使う
    pub port: u16,
    /// 閲覧範囲の起点(正規化済み)
    pub root: PathBuf,
    /// Home の初期位置(範囲外なら root を使う。7.2)
    pub home: PathBuf,
    /// キャッシュの置き場所(~/.cache/dew)
    pub cache_dir: PathBuf,
    /// ffmpeg の同時実行数(7.3)
    pub jobs: usize,
    /// 自己署名証明書の置き場所
    pub tls_dir: PathBuf,
    /// 表示用の URL に使うホスト名とポート(コンテナの外から見た値。2.5)
    pub public_host: Option<String>,
    pub public_port: Option<u16>,
}

/// 待ち受けを始めたときに分かる値
#[derive(Debug, Clone)]
pub struct Ready {
    pub port: u16,
    pub token: String,
    pub instance_id: String,
    /// 端末に表示するトークン付き URL
    pub url: String,
    /// 利用者に知らせる警告
    pub warnings: Vec<String>,
}

pub(crate) struct App {
    pub token: String,
    pub instance_id: String,
    pub root: PathBuf,
    pub home: PathBuf,
    pub media: dew_media::Media,
    pub hub: Arc<events::Hub>,
    pub history: history::Store,
    /// ライブ描画のセッション(最初の dew run / dew env で作る)
    pub live: tokio::sync::Mutex<Option<dew_capture::session::Session>>,
    pub cache_dir: PathBuf,
    pub shutdown: Notify,
}

/// サーバを起動し、止まるまで返らない。待ち受けを始めたら `on_ready` を呼ぶ
pub async fn serve(cfg: Config, on_ready: impl FnOnce(&Ready)) -> anyhow::Result<()> {
    let tls = tls::load_or_create(&cfg.tls_dir, cfg.public_host.as_deref()).await?;
    let listener = bind(cfg.bind, cfg.port)?;
    let port = listener.local_addr()?.port();

    let app = Arc::new(App {
        token: random_hex(32),
        instance_id: random_hex(4),
        home: if cfg.home.starts_with(&cfg.root) {
            cfg.home.clone()
        } else {
            cfg.root.clone()
        },
        root: cfg.root.clone(),
        media: dew_media::Media::new(cfg.cache_dir.join("media"), CACHE_LIMIT, cfg.jobs),
        hub: events::Hub::new(),
        history: history::Store::new(cfg.cache_dir.join("history.json")),
        live: tokio::sync::Mutex::new(None),
        cache_dir: cfg.cache_dir.clone(),
        shutdown: Notify::new(),
    });

    let mut warnings = Vec::new();
    let host = match &cfg.public_host {
        Some(h) => h.clone(),
        None => {
            warnings.push(
                "DEW_PUBLIC_HOST が未設定のため、URL にはこのマシンのホスト名を使います".to_owned(),
            );
            hostname()
        }
    };
    let public_port = match cfg.public_port {
        Some(p) if port == cfg.port => p,
        Some(p) => {
            warnings.push(format!(
                "ポート {} が使用中のため {port} で待ち受けます。DEW_PUBLIC_PORT={p} は使わず、内部のポートで表示します",
                cfg.port
            ));
            port
        }
        None => port,
    };
    let ready = Ready {
        port,
        url: format!("https://{host}:{public_port}/?token={}", app.token),
        token: app.token.clone(),
        instance_id: app.instance_id.clone(),
        warnings,
    };

    let router = router(app.clone());
    let handle = axum_server::Handle::new();
    tokio::spawn({
        let handle = handle.clone();
        let app = app.clone();
        async move {
            app.shutdown.notified().await;
            handle.graceful_shutdown(Some(Duration::from_secs(3)));
        }
    });
    tokio::spawn({
        let app = app.clone();
        async move {
            wait_for_signal().await;
            app.shutdown.notify_one();
        }
    });
    tokio::spawn({
        let app = app.clone();
        async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if app.hub.idle_for().is_some_and(|d| d >= IDLE_LIMIT) {
                    tracing::info!("接続中のタブがない状態が 12 時間続いたので止まります");
                    app.shutdown.notify_one();
                    return;
                }
            }
        }
    });
    on_ready(&ready);
    tracing::info!(port, "待ち受けを開始しました");
    axum_server::from_tcp_rustls(listener, tls)?
        .handle(handle)
        .serve(router.into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    // ライブ描画の仮想ディスプレイと音声サーバも止める
    app.live.lock().await.take();
    Ok(())
}

fn router(app: Arc<App>) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/info", get(info))
        .route("/tree", get(files::tree))
        .route("/media", get(media))
        .route("/history", get(history::list).post(history::add))
        .route("/live/session", post(live::session))
        .route("/probe", get(media::probe))
        .route("/thumb", get(media::thumb))
        .route("/sprite", get(media::sprite))
        .route("/image", get(media::image))
        .route("/pixels", get(media::pixels))
        .route("/open", post(open))
        .route("/shutdown", post(shutdown));
    Router::new()
        .nest("/api", api)
        .route("/ws/events", get(events::ws))
        .fallback(web::static_file)
        .layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_token,
        ))
        .with_state(app)
}

async fn health(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "instanceId": app.instance_id }))
}

async fn info(State(app): State<Arc<App>>) -> Json<Info> {
    Json(Info {
        root: app.root.to_string_lossy().into_owned(),
        home: app.home.to_string_lossy().into_owned(),
    })
}

#[derive(serde::Deserialize)]
struct MediaQuery {
    path: String,
    #[serde(default)]
    transcode: Option<u8>,
    #[serde(default)]
    seg: Option<u32>,
}

/// 原ファイル、または `transcode=1&seg=N` で変換したセグメント
async fn media(
    State(app): State<Arc<App>>,
    Query(q): Query<MediaQuery>,
    req: Request,
) -> Result<Response, files::ApiError> {
    if q.transcode == Some(1) {
        return media::segment(&app, &q.path, q.seg.unwrap_or(0)).await;
    }
    files::media(&app, &q.path, req).await
}

/// `POST /api/open`: CLI からの表示指示を、最後に操作したタブへ送る(F10)
async fn open(
    State(app): State<Arc<App>>,
    Json(req): Json<OpenRequest>,
) -> Result<Json<OpenResponse>, files::ApiError> {
    let path = files::resolve(&app.root, &req.path)?;
    Ok(Json(OpenResponse {
        delivered: app.hub.open(&path),
    }))
}

async fn shutdown(State(app): State<Arc<App>>) -> &'static str {
    app.shutdown.notify_one();
    "ok"
}

/// SIGTERM か Ctrl+C で止める。SIGHUP(ssh の切断)では止まらない(7.1)
async fn wait_for_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM を待てません");
    let mut hup = signal(SignalKind::hangup()).expect("SIGHUP を待てません");
    loop {
        tokio::select! {
            _ = term.recv() => return,
            _ = tokio::signal::ctrl_c() => return,
            _ = hup.recv() => tracing::info!("SIGHUP を受けましたが動作を続けます"),
        }
    }
}

/// 希望のポートから順に空きを探して待ち受ける
fn bind(addr: IpAddr, port: u16) -> anyhow::Result<TcpListener> {
    for p in port..port.saturating_add(PORT_TRIES) {
        match TcpListener::bind((addr, p)) {
            Ok(l) => {
                l.set_nonblocking(true)?;
                return Ok(l);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(e).with_context(|| format!("{addr}:{p} で待ち受けできません")),
        }
    }
    bail!("{addr}:{port} から {PORT_TRIES} 個のポートがすべて使用中です")
}

pub(crate) fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|_| "localhost".to_owned())
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("乱数を取得できません");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
