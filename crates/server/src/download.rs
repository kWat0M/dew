//! ダウンロード(18.3): 1つのファイルはそのまま、複数のファイルとディレクトリは zip にまとめながら送る。
//! 一時ファイルは作らない(大きなディレクトリでもすぐに保存が始まる)

use std::collections::HashSet;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Form;
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use dew_protocol::DownloadSize;
use tokio::sync::mpsc;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use crate::App;
use crate::files::{self, ApiError, PathQuery};

/// `GET /api/download?path=`: 1つのファイルを保存として送る
pub(crate) async fn file(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
    req: Request,
) -> Result<Response, ApiError> {
    let mut res = files::media(&app, &q.path, req).await?;
    let name = Path::new(&q.path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    res.headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition(&name));
    Ok(res)
}

/// `GET /api/download/size?path=&path=`: zip にまとめる前の合計の大きさとファイル数
pub(crate) async fn size(
    State(app): State<Arc<App>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<DownloadSize>, ApiError> {
    let paths = paths(&q);
    let root = app.root.clone();
    let items = blocking(move || collect(&root, &paths)).await?;
    let (bytes, files) = items.iter().fold((0, 0), |(b, n), i| match i {
        Item::File { size, .. } => (b + size, n + 1),
        Item::Dir { .. } => (b, n),
    });
    Ok(Json(DownloadSize { bytes, files }))
}

/// `POST /api/download`(フォームの `path` を複数、`name` に zip の名前): zip にまとめて送る
pub(crate) async fn zip(
    State(app): State<Arc<App>>,
    Form(form): Form<Vec<(String, String)>>,
) -> Result<Response, ApiError> {
    let paths = paths(&form);
    let name = zip_name(
        form.iter()
            .find(|(k, _)| k == "name")
            .map(|(_, v)| v.as_str()),
    );
    let root = app.root.clone();
    let items = blocking(move || collect(&root, &paths)).await?;

    let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
    tokio::task::spawn_blocking(move || {
        let out = Chunks {
            tx: tx.clone(),
            buf: Vec::with_capacity(CHUNK),
        };
        if let Err(e) = write_zip(out, &items) {
            tracing::warn!("zip を作れません: {e}");
            // 途中で失敗したら本文を切り、ブラウザに失敗として見せる
            let _ = tx.blocking_send(Err(std::io::Error::other(e.to_string())));
        }
    });
    let stream = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx));
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            ),
            (header::CONTENT_DISPOSITION, disposition(&name)),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

fn paths(pairs: &[(String, String)]) -> Vec<String> {
    pairs
        .iter()
        .filter(|(k, _)| k == "path")
        .map(|(_, v)| v.clone())
        .collect()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
}

/// zip の名前。パスの区切りは捨て、`.zip` で終える
fn zip_name(name: Option<&str>) -> String {
    let base = name
        .and_then(|n| Path::new(n).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "dew".into());
    if base.to_ascii_lowercase().ends_with(".zip") {
        base
    } else {
        format!("{base}.zip")
    }
}

/// `Content-Disposition`。日本語の名前は `filename*` で送り、古い形の `filename` には ASCII の代わりを入れる
fn disposition(name: &str) -> HeaderValue {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// zip に入れるもの。`rel` は zip の中のパス(区切りは `/`)
#[derive(Debug, PartialEq)]
enum Item {
    Dir {
        rel: String,
    },
    File {
        abs: PathBuf,
        rel: String,
        size: u64,
        mtime: Option<SystemTime>,
        mode: u32,
    },
}

/// 選んだパスを、閲覧範囲の中のファイルとディレクトリの並びにする。
/// zip の中のパスは、選んだものの共通の親からの相対パス(ディレクトリはその名前から入る)
fn collect(root: &Path, paths: &[String]) -> Result<Vec<Item>, ApiError> {
    if paths.is_empty() {
        return Err(ApiError::BadRequest("保存するものがありません".into()));
    }
    let resolved = paths
        .iter()
        .map(|p| files::resolve(root, p))
        .collect::<Result<Vec<_>, _>>()?;
    let base = common_parent(&resolved);
    let mut items = Vec::new();
    let mut visited = HashSet::new();
    for p in &resolved {
        add(root, &base, p, &mut items, &mut visited);
    }
    // ディレクトリとその中のファイルを両方選んだときなど、同じパスは1つにする(zip に同じ名前は入れられない)
    let mut seen = HashSet::new();
    items.retain(|i| {
        seen.insert(match i {
            Item::Dir { rel } | Item::File { rel, .. } => rel.clone(),
        })
    });
    Ok(items)
}

fn common_parent(paths: &[PathBuf]) -> PathBuf {
    let parent = |p: &PathBuf| p.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut base = parent(&paths[0]);
    for p in &paths[1..] {
        while !p.starts_with(&base) {
            if !base.pop() {
                break;
            }
        }
    }
    base
}

/// `path`(範囲の中の実体)を加える。ディレクトリは中もたどる。中のシンボリックリンクは、
/// 範囲の中を指すものだけたどり、同じディレクトリを2度たどらない(輪になったリンクで止まらないように)
fn add(
    root: &Path,
    base: &Path,
    path: &Path,
    items: &mut Vec<Item>,
    visited: &mut HashSet<PathBuf>,
) {
    add_as(root, path, &rel(base, path), items, visited);
}

fn add_as(
    root: &Path,
    path: &Path,
    rel_path: &str,
    items: &mut Vec<Item>,
    visited: &mut HashSet<PathBuf>,
) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.is_dir() {
        if !visited.insert(path.to_path_buf()) {
            return;
        }
        items.push(Item::Dir {
            rel: rel_path.to_string(),
        });
        let Ok(read) = std::fs::read_dir(path) else {
            return;
        };
        let mut children: Vec<_> = read.filter_map(Result::ok).collect();
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let Ok(real) = child.path().canonicalize() else {
                continue;
            };
            if !real.starts_with(root) {
                continue;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            add_as(root, &real, &format!("{rel_path}/{name}"), items, visited);
        }
    } else if meta.is_file() {
        items.push(Item::File {
            abs: path.to_path_buf(),
            rel: rel_path.to_string(),
            size: meta.len(),
            mtime: meta.modified().ok(),
            mode: meta.permissions().mode() & 0o777,
        });
    }
}

fn rel(base: &Path, path: &Path) -> String {
    let r = path.strip_prefix(base).unwrap_or(path);
    let parts: Vec<_> = r
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        // 閲覧範囲の起点そのもの
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "root".into())
    } else {
        parts.join("/")
    }
}

/// すでに圧縮されている形式(Deflate しても小さくならず、時間だけかかる)
fn compressed(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "avif"
            | "heic"
            | "mp4"
            | "m4v"
            | "webm"
            | "mkv"
            | "mov"
            | "avi"
            | "flv"
            | "wmv"
            | "mpg"
            | "mpeg"
            | "ts"
            | "m2ts"
            | "3gp"
            | "ogv"
            | "mp3"
            | "aac"
            | "m4a"
            | "ogg"
            | "opus"
            | "flac"
            | "zip"
            | "gz"
            | "tgz"
            | "bz2"
            | "xz"
            | "zst"
            | "7z"
            | "rar"
            | "jar"
            | "whl"
            | "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "npz"
            | "pt"
            | "pth"
            | "onnx"
            | "parquet"
    )
}

fn write_zip<W: Write>(out: W, items: &[Item]) -> anyhow::Result<()> {
    let mut zip = ZipWriter::new_stream(out);
    for item in items {
        match item {
            Item::Dir { rel } => {
                zip.add_directory(
                    rel.as_str(),
                    SimpleFileOptions::default().unix_permissions(0o755),
                )?;
            }
            Item::File {
                abs,
                rel,
                size,
                mtime,
                mode,
            } => {
                // 読めないファイルは飛ばす(ほかのファイルは保存できるように)
                let Ok(mut f) = std::fs::File::open(abs) else {
                    tracing::warn!("読めないので zip に入れません: {}", abs.display());
                    continue;
                };
                let method = if compressed(rel) {
                    CompressionMethod::Stored
                } else {
                    CompressionMethod::Deflated
                };
                let mut opts = SimpleFileOptions::default()
                    .compression_method(method)
                    .unix_permissions(*mode)
                    .large_file(*size >= u64::from(u32::MAX));
                if let Some(t) = mtime.and_then(dos_time) {
                    opts = opts.last_modified_time(t);
                }
                zip.start_file(rel.as_str(), opts)?;
                std::io::copy(&mut f, &mut zip)?;
            }
        }
    }
    zip.finish()?.into_inner().flush()?;
    Ok(())
}

/// 更新日時(UTC。zip の日時にはタイムゾーンがない)
fn dos_time(t: SystemTime) -> Option<DateTime> {
    let secs = t.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // 1970-01-01 からの日数を年月日に(Howard Hinnant の civil_from_days)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as u16;
    DateTime::from_date_and_time(
        year,
        month,
        day,
        (rem / 3600) as u8,
        (rem / 60 % 60) as u8,
        (rem % 60) as u8,
    )
    .ok()
}

const CHUNK: usize = 64 * 1024;

/// 書いた内容を 64 KiB ずつ本文へ流す。受け手が切れたら書けなくなり、zip を作るのも止まる
struct Chunks {
    tx: mpsc::Sender<std::io::Result<Bytes>>,
    buf: Vec<u8>,
}

impl Chunks {
    fn send(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = std::mem::replace(&mut self.buf, Vec::with_capacity(CHUNK));
        self.tx
            .blocking_send(Ok(Bytes::from(chunk)))
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))
    }
}

impl Write for Chunks {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    fn names(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .map(|i| match i {
                Item::Dir { rel } => format!("{rel}/"),
                Item::File { rel, .. } => rel.clone(),
            })
            .collect()
    }

    #[test]
    fn collects_relative_to_common_parent_and_skips_links_outside() {
        let dir = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("a/sub")).unwrap();
        std::fs::write(root.join("a/one.md"), "# 1").unwrap();
        std::fs::write(root.join("a/sub/two.csv"), "x\n1\n").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("a/out")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("a/secret.txt"))
            .unwrap();
        // 輪になったリンク
        std::os::unix::fs::symlink(root.join("a"), root.join("a/sub/loop")).unwrap();
        // 範囲の中を指すリンクは入る
        std::os::unix::fs::symlink(root.join("b.txt"), root.join("a/b-link.txt")).unwrap();

        let items = collect(&root, &["a".into()]).unwrap();
        assert_eq!(
            names(&items),
            ["a/", "a/b-link.txt", "a/one.md", "a/sub/", "a/sub/two.csv"]
        );
        let items = collect(&root, &["a".into(), "a/one.md".into()]).unwrap();
        assert_eq!(names(&items).iter().filter(|n| *n == "a/one.md").count(), 1);
        let items = collect(&root, &["a/one.md".into(), "b.txt".into()]).unwrap();
        assert_eq!(names(&items), ["a/one.md", "b.txt"]);
        assert!(matches!(
            collect(&root, &["../".into()]),
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            collect(&root, &["a/out".into()]),
            Err(ApiError::Forbidden(_))
        ));
    }

    #[test]
    fn zip_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("d/empty")).unwrap();
        std::fs::write(root.join("d/日本語.md"), "# こんにちは\n".repeat(100)).unwrap();
        std::fs::write(root.join("d/v.mp4"), [0u8, 1, 2, 3]).unwrap();
        let items = collect(&root, &["d".into()]).unwrap();
        let mut out = Vec::new();
        write_zip(&mut out, &items).unwrap();

        let mut z = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        let mut md = String::new();
        z.by_name("d/日本語.md")
            .unwrap()
            .read_to_string(&mut md)
            .unwrap();
        assert_eq!(md, "# こんにちは\n".repeat(100));
        assert_eq!(
            z.by_name("d/日本語.md").unwrap().compression(),
            CompressionMethod::Deflated
        );
        assert_eq!(
            z.by_name("d/v.mp4").unwrap().compression(),
            CompressionMethod::Stored
        );
        assert!(z.by_name("d/empty/").unwrap().is_dir());
    }

    #[test]
    fn names_and_headers() {
        assert_eq!(zip_name(Some("../x/写真")), "写真.zip");
        assert_eq!(zip_name(Some("a.ZIP")), "a.ZIP");
        assert_eq!(zip_name(None), "dew.zip");
        assert_eq!(
            disposition("写真 1.png").to_str().unwrap(),
            "attachment; filename=\"__ 1.png\"; filename*=UTF-8''%E5%86%99%E7%9C%9F%201.png"
        );
        let t = UNIX_EPOCH + std::time::Duration::from_secs(1_761_264_000 + 3 * 3600 + 4 * 60 + 6);
        assert_eq!(
            dos_time(t).unwrap(),
            DateTime::from_date_and_time(2025, 10, 24, 3, 4, 6).unwrap()
        );
    }
}
