//! CSV(16章)の API。小規模モードは全件を解析してブラウザへ渡し、大規模モードは DuckDB に読み込んで
//! 問い合わせごとにページを返す(16.1)

mod parse;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use axum::Json;
use axum::extract::{Query, State};
use dew_protocol::{CsvMode, CsvOptions, CsvPreview, CsvRows, CsvSchema, CsvView, TextEncoding};

use crate::App;
use crate::files::{ApiError, resolve};
use crate::text;

/// サーバが読む CSV の設定(~/.config/dew/config.toml。9.1)
#[derive(Debug, Clone)]
pub struct CsvConfig {
    /// これ以上の大きさのファイルは大規模モード
    pub small_max_bytes: u64,
    /// これ以上の行数なら大規模モード
    pub small_max_rows: u64,
    /// DuckDB のスレッド数とメモリの上限(16.5)
    pub duckdb_threads: u32,
    pub duckdb_memory: String,
}

impl Default for CsvConfig {
    fn default() -> Self {
        CsvConfig {
            small_max_bytes: 20 * 1024 * 1024,
            small_max_rows: 200_000,
            duckdb_threads: 2,
            duckdb_memory: "1GB".into(),
        }
    }
}

/// 解析した小規模モードの表を、いくつか覚えておく(schema と rows で2回解析しないように)
const KEEP: usize = 4;

pub(crate) struct Csv {
    pub config: CsvConfig,
    small: Mutex<Vec<(Key, Arc<Small>)>>,
    /// ファイルの絶対パスごとの表示設定(メモリだけ。dew stop で消える。16.6)
    views: Mutex<std::collections::HashMap<PathBuf, CsvView>>,
}

impl Csv {
    pub(crate) fn new(config: CsvConfig) -> Self {
        Csv {
            config,
            small: Mutex::new(Vec::new()),
            views: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

/// 元ファイルと読み方。ファイルが変われば大きさか更新時刻が変わる
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    path: PathBuf,
    len: u64,
    mtime: u128,
    options: CsvOptions,
}

impl Key {
    fn of(path: &Path, options: &CsvOptions) -> Result<Self, ApiError> {
        let meta = std::fs::metadata(path)
            .map_err(|e| ApiError::NotFound(format!("{} を読めません: {e}", path.display())))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .unwrap_or_default();
        Ok(Key {
            path: path.to_owned(),
            len: meta.len(),
            mtime: mtime.as_nanos(),
            options: options.clone(),
        })
    }
}

pub(crate) struct Small {
    schema: CsvSchema,
    table: parse::Table,
}

#[derive(serde::Deserialize)]
pub(crate) struct CsvParams {
    path: String,
    #[serde(default)]
    encoding: Option<TextEncoding>,
    #[serde(default)]
    delimiter: Option<String>,
    #[serde(default)]
    header: Option<bool>,
}

impl CsvParams {
    fn options(&self) -> CsvOptions {
        CsvOptions {
            encoding: self.encoding,
            delimiter: self.delimiter.clone(),
            header: self.header,
        }
    }
}

/// 区切り文字の手動設定(1文字。"\t" はタブ)
fn delimiter_of(s: &str) -> Result<u8, ApiError> {
    match s {
        "\\t" | "\t" => Ok(b'\t'),
        s if s.len() == 1 && s.is_ascii() => Ok(s.as_bytes()[0]),
        _ => Err(ApiError::BadRequest(format!("区切り文字は1文字です: {s}"))),
    }
}

fn delimiter_text(d: u8) -> String {
    (d as char).to_string()
}

fn is_tsv(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("tsv"))
}

/// 小規模モードで読めるなら解析した表。大規模モードなら None
fn load_small(
    csv: &Csv,
    path: &Path,
    options: &CsvOptions,
) -> Result<Option<Arc<Small>>, ApiError> {
    let key = Key::of(path, options)?;
    if let Some((_, s)) = csv.small.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(Some(s.clone()));
    }
    if key.len >= csv.config.small_max_bytes {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|e| ApiError::NotFound(format!("{} を読めません: {e}", path.display())))?;
    let detected = text::detect(&bytes);
    let encoding = options.encoding.unwrap_or(detected);
    let decoded = text::decode(&bytes, encoding);
    let delimiter = match &options.delimiter {
        Some(d) => delimiter_of(d)?,
        None => parse::sniff_delimiter(decoded.as_bytes(), is_tsv(path)),
    };
    let table = parse::parse(&decoded, delimiter, options.header);
    if table.rows >= csv.config.small_max_rows {
        return Ok(None);
    }
    let small = Arc::new(Small {
        schema: CsvSchema {
            mode: CsvMode::Small,
            columns: table.columns.clone(),
            encoding,
            detected,
            delimiter: delimiter_text(delimiter),
            header: table.header,
            rows: table.rows,
            ragged: table.ragged,
            ready: true,
        },
        table,
    });
    let mut cache = csv.small.lock().unwrap();
    cache.retain(|(k, _)| k.path != key.path);
    cache.push((key, small.clone()));
    if cache.len() > KEEP {
        cache.remove(0);
    }
    Ok(Some(small))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
}

fn csv_path(app: &App, path: &str) -> Result<PathBuf, ApiError> {
    let p = resolve(&app.root, path)?;
    if p.is_dir() {
        return Err(ApiError::NotFound(format!("ディレクトリです: {path}")));
    }
    Ok(p)
}

/// `GET /api/csv/schema`: モード・列・文字コード・区切り文字・行数など(16.8)
pub(crate) async fn schema(
    State(app): State<Arc<App>>,
    Query(q): Query<CsvParams>,
) -> Result<Json<CsvSchema>, ApiError> {
    let path = csv_path(&app, &q.path)?;
    let options = q.options();
    let a = app.clone();
    blocking(move || match load_small(&a.csv, &path, &options)? {
        Some(s) => Ok(Json(s.schema.clone())),
        None => Err(ApiError::Unavailable("大規模モードはまだありません".into())),
    })
    .await
}

/// `GET /api/csv/rows`: 小規模モードの全行(列ごと)
pub(crate) async fn rows(
    State(app): State<Arc<App>>,
    Query(q): Query<CsvParams>,
) -> Result<Json<CsvRows>, ApiError> {
    let path = csv_path(&app, &q.path)?;
    let options = q.options();
    let a = app.clone();
    blocking(move || match load_small(&a.csv, &path, &options)? {
        Some(s) => Ok(Json(CsvRows {
            columns: s.table.cells.clone(),
        })),
        None => Err(ApiError::BadRequest(
            "大規模モードの CSV です。/api/csv/query で問い合わせてください".into(),
        )),
    })
    .await
}

#[derive(serde::Deserialize)]
pub(crate) struct PathParam {
    path: String,
}

/// `GET /api/csv/view`: 表示設定(なければ null)
pub(crate) async fn view(
    State(app): State<Arc<App>>,
    Query(q): Query<PathParam>,
) -> Result<Json<Option<CsvView>>, ApiError> {
    let path = csv_path(&app, &q.path)?;
    Ok(Json(app.csv.views.lock().unwrap().get(&path).cloned()))
}

/// `PUT /api/csv/view`: 表示設定を置く
pub(crate) async fn save_view(
    State(app): State<Arc<App>>,
    Query(q): Query<PathParam>,
    Json(v): Json<CsvView>,
) -> Result<axum::http::StatusCode, ApiError> {
    let path = csv_path(&app, &q.path)?;
    app.csv.views.lock().unwrap().insert(path, v);
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// プレビューに出す行と列の数、読む先頭の大きさ(15.5)
const PREVIEW_ROWS: usize = 20;
const PREVIEW_COLS: usize = 10;
const PREVIEW_BYTES: u64 = 256 * 1024;

/// `GET /api/csv/preview`: 先頭だけを読んで小さな表にする(大きなファイルでもデータベースに読み込まない)
pub(crate) async fn preview(
    State(app): State<Arc<App>>,
    Query(q): Query<PathParam>,
) -> Result<Json<CsvPreview>, ApiError> {
    let path = csv_path(&app, &q.path)?;
    blocking(move || {
        use std::io::Read;
        let mut head = Vec::new();
        std::fs::File::open(&path)
            .and_then(|f| f.take(PREVIEW_BYTES).read_to_end(&mut head))
            .map_err(|e| ApiError::NotFound(format!("{} を読めません: {e}", path.display())))?;
        let encoding = text::detect(&head);
        let decoded = text::decode(&head, encoding);
        let delimiter = parse::sniff_delimiter(decoded.as_bytes(), is_tsv(&path));
        let mut rd = parse::reader(decoded.as_bytes(), delimiter);
        let mut records = rd.records().filter_map(Result::ok).take(PREVIEW_ROWS + 1);
        let first: Vec<String> = records
            .next()
            .map(|r| r.iter().map(str::to_owned).collect())
            .unwrap_or_default();
        let cut = |r: &csv::StringRecord| {
            r.iter()
                .take(PREVIEW_COLS)
                .map(|v| (!v.is_empty()).then(|| v.to_owned()))
                .collect::<Vec<_>>()
        };
        let mut rows: Vec<Vec<Option<String>>> = records.map(|r| cut(&r)).collect();
        let columns = if parse::looks_like_header(&first) {
            first
                .iter()
                .take(PREVIEW_COLS)
                .enumerate()
                .map(|(i, n)| {
                    if n.is_empty() {
                        format!("列{}", i + 1)
                    } else {
                        n.clone()
                    }
                })
                .collect()
        } else {
            rows.insert(
                0,
                first
                    .iter()
                    .take(PREVIEW_COLS)
                    .map(|v| (!v.is_empty()).then(|| v.clone()))
                    .collect(),
            );
            rows.truncate(PREVIEW_ROWS);
            (1..=first.len().min(PREVIEW_COLS))
                .map(|i| format!("列{i}"))
                .collect()
        };
        Ok(Json(CsvPreview {
            columns,
            rows,
            encoding,
            delimiter: delimiter_text(delimiter),
        }))
    })
    .await
}
