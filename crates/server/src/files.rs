//! ファイル API: ディレクトリ一覧と原ファイルの配信(読み取り専用。7.2)

use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::UNIX_EPOCH;

use axum::Json;
use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use dew_protocol::{Entry, EntryKind, MediaKind, Tree};
use serde::Deserialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::App;

#[derive(Deserialize)]
pub(crate) struct PathQuery {
    pub path: String,
}

/// API の失敗。本文は利用者に見せる日本語の説明
#[derive(Debug)]
pub(crate) enum ApiError {
    Forbidden(String),
    NotFound(String),
    /// 機能に要るツールがない(何を入れればよいかを伝える)
    Unavailable(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            Self::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Self::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
            Self::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, msg).into_response()
    }
}

/// `path` を閲覧範囲の中の実在するパスにする。相対パスは起点からの位置とみなす。
/// シンボリックリンクはたどり、たどった先が範囲外なら拒否する
pub(crate) fn resolve(root: &Path, path: &str) -> Result<PathBuf, ApiError> {
    let joined = root.join(path);
    match joined.canonicalize() {
        Ok(p) if p.starts_with(root) => Ok(p),
        Ok(_) => Err(ApiError::Forbidden(format!("閲覧範囲の外です: {path}"))),
        // 存在しないときも、範囲外を指していれば 403 にする(範囲外の有無を漏らさない)
        Err(_) if !normalize(&joined).starts_with(root) => {
            Err(ApiError::Forbidden(format!("閲覧範囲の外です: {path}")))
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Err(ApiError::Forbidden(
            format!("読み取り権限がありません: {path}"),
        )),
        Err(_) => Err(ApiError::NotFound(format!("見つかりません: {path}"))),
    }
}

/// `..` と `.` を字面だけで畳む
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// `GET /api/tree?path=`
pub(crate) async fn tree(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Tree>, ApiError> {
    let dir = resolve(&app.root, &q.path)?;
    let root = app.root.clone();
    tokio::task::spawn_blocking(move || list(&root, &dir))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .map(Json)
}

fn list(root: &Path, dir: &Path) -> Result<Tree, ApiError> {
    let read = std::fs::read_dir(dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            ApiError::Forbidden(format!("読み取り権限がありません: {}", dir.display()))
        }
        std::io::ErrorKind::NotADirectory => {
            ApiError::NotFound(format!("ディレクトリではありません: {}", dir.display()))
        }
        _ => ApiError::NotFound(format!("{}: {e}", dir.display())),
    })?;
    let mut entries: Vec<Entry> = read
        .filter_map(Result::ok)
        .map(|e| entry(&e.path()))
        .collect();
    entries.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Dir, EntryKind::File) => Ordering::Less,
        (EntryKind::File, EntryKind::Dir) => Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(Tree {
        path: dir.to_string_lossy().into_owned(),
        parent: (dir != root)
            .then(|| dir.parent().map(|p| p.to_string_lossy().into_owned()))
            .flatten(),
        entries,
    })
}

pub(crate) fn entry(path: &Path) -> Entry {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    // シンボリックリンクはたどった先の情報。リンク切れはリンク自身の情報で、読めない扱い
    let (meta, broken) = match std::fs::metadata(path) {
        Ok(m) => (Some(m), false),
        Err(_) => (std::fs::symlink_metadata(path).ok(), true),
    };
    let kind = if meta.as_ref().is_some_and(|m| m.is_dir()) {
        EntryKind::Dir
    } else {
        EntryKind::File
    };
    Entry {
        media: if kind == EntryKind::Dir {
            MediaKind::Other
        } else {
            media_kind(&name)
        },
        kind,
        size: meta.as_ref().map_or(0, |m| m.len()),
        mtime: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_millis() as f64),
        readable: !broken && meta.as_ref().is_some_and(|m| readable(m, kind)),
        name,
    }
}

/// 拡張子から種別を決める
pub(crate) fn media_kind(name: &str) -> MediaKind {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "svg" | "bmp" | "tif" | "tiff" => {
            MediaKind::Image
        }
        "mp4" | "m4v" | "webm" | "mkv" | "avi" | "mov" | "flv" | "wmv" | "mpg" | "mpeg" | "ts"
        | "m2ts" | "3gp" | "ogv" => MediaKind::Video,
        "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "opus" => MediaKind::Audio,
        "md" | "markdown" => MediaKind::Markdown,
        _ => MediaKind::Other,
    }
}

/// 起動したユーザーの権限で読めるか(ディレクトリは中を一覧できるか)。
/// 1万件のディレクトリでもファイルを開かずに済むよう、権限ビットで判定する
fn readable(meta: &std::fs::Metadata, kind: EntryKind) -> bool {
    use std::os::unix::fs::MetadataExt;
    let ids = &*IDS;
    if ids.uid == 0 {
        return true;
    }
    let need = if kind == EntryKind::Dir { 0o5 } else { 0o4 };
    let mode = meta.mode();
    let bits = if meta.uid() == ids.uid {
        mode >> 6
    } else if ids.gids.contains(&meta.gid()) {
        mode >> 3
    } else {
        mode
    };
    bits & need == need
}

struct Ids {
    uid: u32,
    gids: Vec<u32>,
}

/// 実効 UID と所属グループ(/proc/self/status から読む)
static IDS: LazyLock<Ids> = LazyLock::new(|| {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |key: &str| -> Vec<u32> {
        status
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .map(|v| {
                v.split_whitespace()
                    .filter_map(|n| n.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    };
    // Uid: 実 実効 保存 ファイルシステム
    let uid = field("Uid:").get(1).copied().unwrap_or(u32::MAX);
    let mut gids = field("Groups:");
    gids.extend(field("Gid:").get(1));
    Ids { uid, gids }
});

/// `GET /api/media?path=`: 原ファイル。Range に対応する
pub(crate) async fn media(app: &App, path: &str, req: Request) -> Result<Response, ApiError> {
    let file = resolve(&app.root, path)?;
    if !file.is_file() {
        return Err(ApiError::NotFound(format!(
            "ファイルではありません: {path}"
        )));
    }
    if let Err(e) = std::fs::File::open(&file) {
        return Err(ApiError::Forbidden(format!("開けません: {path}: {e}")));
    }
    let res = ServeFile::new(&file)
        .oneshot(req)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(res.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("a")).unwrap();
        std::os::unix::fs::symlink("/", root.join("up")).unwrap();
        std::os::unix::fs::symlink(root.join("a"), root.join("in")).unwrap();

        assert_eq!(resolve(&root, "a").unwrap(), root.join("a"));
        assert_eq!(
            resolve(&root, root.join("in").to_str().unwrap()).unwrap(),
            root.join("a")
        );
        assert_eq!(resolve(&root, "").unwrap(), root);
        for p in ["..", "a/../..", "/etc", "up", "up/etc", "../nonexistent"] {
            assert!(
                matches!(resolve(&root, p), Err(ApiError::Forbidden(_))),
                "{p}"
            );
        }
        assert!(matches!(
            resolve(&root, "nonexistent"),
            Err(ApiError::NotFound(_))
        ));
    }

    #[test]
    fn media_kind_by_extension() {
        assert_eq!(media_kind("a.MP4"), MediaKind::Video);
        assert_eq!(media_kind("a.webp"), MediaKind::Image);
        assert_eq!(media_kind("a.flac"), MediaKind::Audio);
        assert_eq!(media_kind("Makefile"), MediaKind::Other);
        assert_eq!(media_kind("README.MD"), MediaKind::Markdown);
    }
}
