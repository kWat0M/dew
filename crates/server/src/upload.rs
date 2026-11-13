//! アップロード(19章): ブラウザから送られたファイルを、Home で開いているディレクトリに新しいファイルとして書く。
//! 同じ名前のファイルがあれば上書きせず「名前 (1).拡張子」にする。書きかけは隠しファイルに書き、
//! 送り終わってから名前を付ける(途中で切れたら消す)。削除・移動・上書きはしない

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use dew_protocol::UploadResult;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::App;
use crate::files::{self, ApiError};

/// 番号を付けて探す上限(これを超えたら諦める)
const MAX_SUFFIX: u32 = 1000;

#[derive(Deserialize)]
pub(crate) struct UploadQuery {
    dir: String,
    name: String,
}

/// `PUT /api/upload?dir=&name=`: 本文をそのままファイルにする(1回に1ファイル。大きなファイルも少しずつ書く)
pub(crate) async fn upload(
    State(app): State<Arc<App>>,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> Result<Json<UploadResult>, ApiError> {
    check_name(&q.name)?;
    let dir = files::resolve(&app.root, &q.dir)?;
    if !dir.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "ディレクトリではありません: {}",
            q.dir
        )));
    }
    let tmp = Partial(dir.join(temp_name()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp.0)
        .await
        .map_err(|e| write_error(e, &q.dir))?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| ApiError::BadRequest(format!("送信が途中で切れました: {e}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| write_error(e, &q.dir))?;
    }
    file.flush().await.map_err(|e| write_error(e, &q.dir))?;
    drop(file);
    let name = q.name.clone();
    let shown_dir = q.dir.clone();
    let placed = tokio::task::spawn_blocking(move || {
        let r = place(&tmp.0, &dir, &name);
        if r.is_ok() {
            tmp.keep();
        }
        r
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
    .map_err(|e| write_error(e, &shown_dir))?;
    tracing::info!(dir = %q.dir, name = %placed, "アップロードを保存しました");
    Ok(Json(UploadResult { name: placed }))
}

/// 書きかけのファイル。保存し終える前に落とされたら(送信が切れた、失敗した)消す
struct Partial(PathBuf);

impl Partial {
    /// 名前を付け終えた(書きかけはもうない)
    fn keep(self) {
        std::mem::forget(self);
    }
}

impl Drop for Partial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 書きかけの名前(隠しファイル。元の名前は入れない。長い名前でも上限を超えないように)
fn temp_name() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        ".dew-upload-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// ファイル名として使えるか(ディレクトリをまたぐ名前は受け付けない)
fn check_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\0')
        || name.len() > 255
    {
        return Err(ApiError::BadRequest(format!(
            "ファイル名として使えません: {name}"
        )));
    }
    Ok(())
}

/// 書きかけに名前を付ける。同じ名前があれば番号を付けた名前を探す。返り値は付けた名前
fn place(tmp: &Path, dir: &Path, name: &str) -> std::io::Result<String> {
    for n in 0..=MAX_SUFFIX {
        let candidate = numbered(name, n);
        let target = dir.join(&candidate);
        // ハードリンクはすでにあると失敗するので、ほかから同時に作られても上書きしない
        match std::fs::hard_link(tmp, &target) {
            Ok(()) => {
                std::fs::remove_file(tmp)?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            // ハードリンクを作れないファイルシステムでは、ないことを確かめてから名前を変える
            Err(_) if !target.exists() && target.symlink_metadata().is_err() => {
                std::fs::rename(tmp, &target)?;
                return Ok(candidate);
            }
            Err(_) => continue,
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        format!("同じ名前のファイルが多すぎます: {name}"),
    ))
}

/// `photo.png` → `photo (1).png`(n が 0 ならそのまま)。拡張子は最初の `.` から(`a.tar.gz` → `a (1).tar.gz`)。
/// `.` で始まる名前は全体を名前とみなす
fn numbered(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_owned();
    }
    // 先頭の1文字は飛ばす(`.` で始まる名前のため)。日本語の名前でも文字の途中で切らない
    let first = name.chars().next().map_or(0, char::len_utf8);
    match name[first..].find('.').map(|i| i + first) {
        Some(i) => format!("{} ({n}){}", &name[..i], &name[i..]),
        None => format!("{name} ({n})"),
    }
}

fn write_error(e: std::io::Error, dir: &str) -> ApiError {
    match e.kind() {
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => {
            ApiError::Forbidden(format!("書き込み権限がありません: {dir}"))
        }
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => {
            ApiError::Internal(format!("ディスクの空きが足りません: {dir}"))
        }
        _ => ApiError::Internal(format!("書き込めません: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_keeps_extension() {
        assert_eq!(numbered("photo.png", 0), "photo.png");
        assert_eq!(numbered("photo.png", 1), "photo (1).png");
        assert_eq!(numbered("a.tar.gz", 2), "a (2).tar.gz");
        assert_eq!(numbered("README", 1), "README (1)");
        assert_eq!(numbered(".bashrc", 1), ".bashrc (1)");
        assert_eq!(numbered("日本語.csv", 1), "日本語 (1).csv");
    }

    #[test]
    fn names_with_slash_are_rejected() {
        for bad in ["", ".", "..", "a/b", "../x", "a\0b"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_name(".hidden").is_ok());
        assert!(check_name(&"a".repeat(256)).is_err());
    }

    #[test]
    fn place_does_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "old").unwrap();
        let tmp = dir.path().join(temp_name());
        std::fs::write(&tmp, "new").unwrap();
        assert_eq!(place(&tmp, dir.path(), "a.txt").unwrap(), "a (1).txt");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a (1).txt")).unwrap(),
            "new"
        );
        assert!(!tmp.exists());
    }
}
