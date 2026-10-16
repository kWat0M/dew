//! ライブ描画(フェーズ3)の API

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use dew_capture::session::Session;
use dew_protocol::LiveSession;

use crate::App;
use crate::files::ApiError;

/// `POST /api/live/session`: セッションがなければ作り、アプリにつなぐ設定を返す(dew run / dew env)
pub(crate) async fn session(State(app): State<Arc<App>>) -> Result<Json<LiveSession>, ApiError> {
    let mut live = app.live.lock().await;
    if live.is_none() {
        let s = Session::start(&app.cache_dir.join("live"))
            .await
            .map_err(|e| ApiError::Internal(format!("{e:#}")))?;
        *live = Some(s);
    }
    let s = live.as_ref().unwrap();
    Ok(Json(LiveSession {
        display: format!(":{}", s.display),
        env: s.env(),
        unset: Session::UNSET.iter().map(|v| (*v).to_owned()).collect(),
    }))
}
