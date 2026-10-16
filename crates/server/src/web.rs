//! フロントエンド(web/dist)の配信。リリースビルドではバイナリに埋め込み、
//! デバッグビルドでは実行時に web/dist を読む(rust-embed の既定の動作)

use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../web/dist"]
struct Assets;

pub(crate) async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // 画面の切替はブラウザ側で行うため、知らないパスには index.html を返す
    let (path, file) = match Assets::get(path) {
        Some(f) if !path.is_empty() => (path, f),
        _ if path.starts_with("api/") => return StatusCode::NOT_FOUND.into_response(),
        _ => match Assets::get("index.html") {
            Some(f) => ("index.html", f),
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "web/dist がありません。pnpm -C web build を実行してください\n",
                )
                    .into_response();
            }
        },
    };
    // ファイル名にハッシュが付く assets/ は長くキャッシュさせる
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, file.metadata.mimetype().to_owned()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        file.data,
    )
        .into_response()
}
