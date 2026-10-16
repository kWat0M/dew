//! 調査・サムネイル・スプライト・変換の API。中身は dew-media クレート

use std::path::Path;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use dew_media::Cache;
use dew_protocol::{MediaKind, Probe};

use crate::App;
use crate::files::{ApiError, PathQuery, media_kind, resolve};

fn failed(e: anyhow::Error) -> ApiError {
    ApiError::Internal(format!("{e:#}"))
}

fn file(app: &App, path: &str) -> Result<std::path::PathBuf, ApiError> {
    let p = resolve(&app.root, path)?;
    if !p.is_file() {
        return Err(ApiError::NotFound(format!(
            "ファイルではありません: {path}"
        )));
    }
    Ok(p)
}

/// `GET /api/probe?path=`
pub(crate) async fn probe(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Probe>, ApiError> {
    let p = file(&app, &q.path)?;
    app.media.probe(&p).await.map(Json).map_err(failed)
}

/// `GET /api/thumb?path=`
pub(crate) async fn thumb(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let p = file(&app, &q.path)?;
    let video = match media_kind(&q.path) {
        MediaKind::Video => true,
        MediaKind::Image => false,
        _ => {
            return Err(ApiError::NotFound(format!(
                "サムネイルを作れない種類です: {}",
                q.path
            )));
        }
    };
    let out = app.media.thumb(&p, video).await.map_err(failed)?;
    send(&out, "image/webp", None).await
}

/// `GET /api/sprite?path=`
pub(crate) async fn sprite(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let p = file(&app, &q.path)?;
    let out = app.media.sprite(&p).await.map_err(failed)?;
    send(&out, "image/webp", None).await
}

/// `GET /api/media?path=&transcode=1&seg=N`
pub(crate) async fn segment(app: &App, path: &str, index: u32) -> Result<Response, ApiError> {
    let p = file(app, path)?;
    let (out, cache) = app.media.segment(&p, index).await.map_err(failed)?;
    send(&out, "video/mp4", Some(cache)).await
}

/// キャッシュ済みのファイルを返す。URL は元ファイルの更新時刻を含まないので、ブラウザには短くだけ覚えさせる
async fn send(path: &Path, mime: &'static str, cache: Option<Cache>) -> Result<Response, ApiError> {
    let body = tokio::fs::read(path)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let mut res = (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, max-age=60"),
        ],
        body,
    )
        .into_response();
    if let Some(c) = cache {
        let v = if c == Cache::Hit { "hit" } else { "miss" };
        res.headers_mut().insert("x-dew-cache", v.parse().unwrap());
    }
    Ok(res)
}
