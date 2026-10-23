//! HTTP / WebSocket サーバとファイル API。1ポートに HTTPS で載せる

mod auth;
mod csv;
mod events;
mod files;
mod history;
mod live;
mod media;
mod persist;
mod shells;
mod text;
mod tls;
mod web;

pub use csv::CsvConfig;
pub use persist::rotate_token;

use std::net::{IpAddr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{Context, bail};
use axum::Router;
use axum::extract::{Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, middleware};
use dew_protocol::{
    Info, OpenRequest, OpenResponse, RotateTokenResponse, ShellCount, ShellRequest,
};
use tokio::sync::Notify;

/// キャッシュの上限(9.1)
const CACHE_LIMIT: u64 = 5 * 1024 * 1024 * 1024;

/// 接続中のタブがない状態がこれだけ続いたら自動で止まる(7.1)
const IDLE_LIMIT: Duration = Duration::from_secs(12 * 3600);

/// 待ち受けポートが使用中のとき、次の番号を試す回数
const PORT_TRIES: u16 = 100;

/// 既定の待ち受けポート(9.1)
pub const DEFAULT_PORT: u16 = 8765;

/// activate 中のシェルを点検する間隔。仕様は「1分ごと」だが、軽い処理なので短くして、
/// 端末を閉じてから登録が消えるまでを早める(13.6)
const SHELL_CHECK: Duration = Duration::from_secs(10);

/// サーバの起動設定
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: IpAddr,
    /// 指定されたポート(--port / DEW_PORT)。使用中なら次の空きを使う。
    /// 指定がなければ前回のポートを試し、だめなら 8765 から探す(13.6)
    pub port: Option<u16>,
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
    /// 起動し直しても変えない値(トークンなど)の置き場所(~/.local/share/dew)
    pub state_dir: PathBuf,
    /// CSV の閾値と DuckDB の資源(config.toml)
    pub csv: CsvConfig,
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
    /// `dew rotate-token` で動いている間にも変わる
    token: RwLock<String>,
    pub instance_id: String,
    pub root: PathBuf,
    pub home: PathBuf,
    pub media: dew_media::Media,
    pub hub: Arc<events::Hub>,
    pub history: history::Store,
    /// ライブ描画のセッション(最初の dew run / dew env で作る)
    pub live: tokio::sync::Mutex<Option<dew_capture::session::Session>>,
    /// 映っているライブ描画のウィンドウ
    pub live_windows: Arc<live::Live>,
    pub cache_dir: PathBuf,
    pub shutdown: Notify,
    /// 起動し直しても変えない値
    pub store: persist::Store,
    /// activate 中のシェル
    pub shells: shells::Shells,
    /// CSV の解析結果と大規模モードのデータベース
    pub csv: csv::Csv,
}

impl App {
    pub(crate) fn token(&self) -> String {
        self.token.read().unwrap().clone()
    }
}

/// サーバを起動し、止まるまで返らない。待ち受けを始めたら `on_ready` を呼ぶ
pub async fn serve(cfg: Config, on_ready: impl FnOnce(&Ready)) -> anyhow::Result<()> {
    let tls = tls::load_or_create(&cfg.tls_dir, cfg.public_host.as_deref()).await?;
    let store = persist::Store::open(&cfg.state_dir);
    // 前回のポートは、ポートを公開する形(docker run -p。DEW_PUBLIC_PORT がある)では使わない。
    // 公開しているのはコンテナ内の 8765 なので、ほかの番号にすると外から届かない
    let saved = (cfg.port.is_none() && cfg.public_port.is_none())
        .then(|| store.port())
        .flatten();
    let wanted = cfg.port.unwrap_or(DEFAULT_PORT);
    let listener = bind(cfg.bind, saved, wanted)?;
    let port = listener.local_addr()?.port();
    store.set_port(port);

    let app = Arc::new(App {
        token: RwLock::new(store.token()),
        instance_id: store.instance_id(),
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
        live_windows: Arc::new(live::Live::new()),
        cache_dir: cfg.cache_dir.clone(),
        shutdown: Notify::new(),
        store,
        shells: shells::Shells::default(),
        csv: csv::Csv::new(cfg.csv.clone()),
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
        Some(p) if port == wanted => p,
        Some(p) => {
            warnings.push(format!(
                "ポート {wanted} が使用中のため {port} で待ち受けます。DEW_PUBLIC_PORT={p} は使わず、内部のポートで表示します"
            ));
            port
        }
        None => port,
    };
    let ready = Ready {
        port,
        url: format!("https://{host}:{public_port}/?token={}", app.token()),
        token: app.token(),
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
                // activate 中のシェルがある間は止まらない。最後のシェルが終わってから数え直す(13.6)
                if app.shells.count() > 0 {
                    app.hub.restart_idle();
                    continue;
                }
                if app.hub.idle_for().is_some_and(|d| d >= IDLE_LIMIT) {
                    tracing::info!("接続中のタブがない状態が 12 時間続いたので止まります");
                    app.shutdown.notify_one();
                    return;
                }
            }
        }
    });
    tokio::spawn({
        let app = app.clone();
        async move {
            loop {
                tokio::time::sleep(SHELL_CHECK).await;
                app.shells.prune();
            }
        }
    });
    on_ready(&ready);
    tracing::info!(port, "待ち受けを開始しました");
    axum_server::from_tcp_rustls(listener, tls)?
        .handle(handle)
        .serve(router.into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    // ライブ描画の取り込みと、仮想ディスプレイ・音声サーバも止める
    app.live_windows.clear();
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
        .route("/live/record", post(live::record))
        .route("/probe", get(media::probe))
        .route("/thumb", get(media::thumb))
        .route("/sprite", get(media::sprite))
        .route("/image", get(media::image))
        .route("/pixels", get(media::pixels))
        .route("/text", get(text::text))
        .route("/csv/schema", get(csv::schema))
        .route("/csv/rows", get(csv::rows))
        .route("/csv/view", get(csv::view).put(csv::save_view))
        .route("/csv/preview", get(csv::preview))
        .route("/csv/query", post(csv::query))
        .route("/csv/search", post(csv::search))
        .route("/csv/locate", post(csv::locate))
        .route("/csv/cancel", post(csv::cancel))
        .route("/open", post(open))
        .route("/shell", post(shell))
        .route("/shells", get(shells))
        .route("/rotate-token", post(rotate))
        .route("/shutdown", post(shutdown));
    Router::new()
        .nest("/api", api)
        .route("/open", get(open_page))
        .route("/ws/events", get(events::ws))
        .route("/ws/live/{id}", get(live::ws))
        .route("/ws/live-audio", get(live::audio_ws))
        .route("/ws/live-audio/{id}", get(live::window_audio_ws))
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

#[derive(serde::Deserialize)]
struct OpenPageQuery {
    #[serde(default)]
    path: Option<String>,
}

/// `GET /open?path=`: 端末から開かせる URL(14.3)。トークンの処理(Cookie へ移す)は認証の層で済んでいる。
/// 開くファイルを予約して Home へ移り、つないだタブがそのファイルを開く(14.4 の予約と同じ仕組み)
async fn open_page(
    State(app): State<Arc<App>>,
    Query(q): Query<OpenPageQuery>,
) -> Result<Response, files::ApiError> {
    if let Some(p) = q.path.filter(|p| !p.is_empty()) {
        let path = files::resolve(&app.root, &p)?;
        app.hub.reserve(&path);
    }
    Ok((StatusCode::SEE_OTHER, [(header::LOCATION, "/")]).into_response())
}

/// `POST /api/shell`: activate / deactivate したシェルの登録と取り消し(13.6)
async fn shell(State(app): State<Arc<App>>, Json(req): Json<ShellRequest>) -> StatusCode {
    if !req.active {
        app.shells.unregister(req.pid);
        StatusCode::OK
    } else if app.shells.register(req.pid) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn shells(State(app): State<Arc<App>>) -> Json<ShellCount> {
    Json(ShellCount {
        count: app.shells.count() as u32,
    })
}

/// `POST /api/rotate-token`: トークンを作り直す。接続中のタブは切る(14.6)
async fn rotate(State(app): State<Arc<App>>) -> Result<Json<RotateTokenResponse>, files::ApiError> {
    let token = app
        .store
        .rotate_token()
        .map_err(|e| files::ApiError::Internal(format!("{e:#}")))?;
    *app.token.write().unwrap() = token.clone();
    app.hub.disconnect_all();
    Ok(Json(RotateTokenResponse { token }))
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

/// `first`(前回のポート)を試し、だめなら `port` から順に空きを探して待ち受ける
fn bind(addr: IpAddr, first: Option<u16>, port: u16) -> anyhow::Result<TcpListener> {
    let candidates = first
        .into_iter()
        .chain(port..port.saturating_add(PORT_TRIES));
    for p in candidates {
        match TcpListener::bind((addr, p)) {
            Ok(l) => {
                l.set_nonblocking(true)?;
                return Ok(l);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            // 前回のポートが使えないときは、理由を問わず既定の番号から探す
            Err(_) if Some(p) == first => continue,
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

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("乱数を取得できません");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
