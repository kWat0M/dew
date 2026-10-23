//! CSV(16章)の API。小規模モードは全件を解析してブラウザへ渡し、大規模モードは DuckDB に読み込んで
//! 問い合わせごとにページを返す(16.1)

mod duck;
mod parse;
mod sql;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Query, State};
use dew_protocol::{
    CsvMatches, CsvMode, CsvOptions, CsvPage, CsvPreview, CsvQuery, CsvRows, CsvSchema, CsvSearch,
    CsvView, ServerEvent, TextEncoding,
};

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
    views: Mutex<HashMap<PathBuf, CsvView>>,
    /// 大規模モードのデータベース(読み込み中・済み・失敗)
    large: Mutex<HashMap<Key, Large>>,
}

enum Large {
    /// 読み込み中。true にすると止める
    Running(Arc<AtomicBool>),
    Ready(Arc<duck::Db>),
    Failed(String),
}

impl Csv {
    pub(crate) fn new(config: CsvConfig) -> Self {
        Csv {
            config,
            small: Mutex::new(Vec::new()),
            views: Mutex::new(HashMap::new()),
            large: Mutex::new(HashMap::new()),
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
        None => large_schema(&a, &path, &options).map(Json),
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

/// キャッシュの上限(media と合わせて。9.1)
const CACHE_LIMIT: u64 = 5 * 1024 * 1024 * 1024;

/// 大規模モードのデータベースの置き場所。元ファイル・大きさ・更新時刻・読み方から名前を決める
fn db_path(app: &App, key: &Key) -> PathBuf {
    let mut h = std::hash::DefaultHasher::new();
    key.hash(&mut h);
    app.cache_dir
        .join("csv")
        .join(format!("{:016x}.duckdb", h.finish()))
}

/// 読み込み中のスキーマ(列はまだ分からない)
fn pending(encoding: TextEncoding, detected: TextEncoding) -> CsvSchema {
    CsvSchema {
        mode: CsvMode::Large,
        columns: Vec::new(),
        encoding,
        detected,
        delimiter: String::new(),
        header: false,
        rows: 0,
        ragged: 0,
        ready: false,
    }
}

/// 大規模モードのスキーマ。データベースがなければ読み込みを始め、済むまでは ready: false を返す(進捗は CsvProgress で送る)
fn large_schema(app: &Arc<App>, path: &Path, options: &CsvOptions) -> Result<CsvSchema, ApiError> {
    let key = Key::of(path, options)?;
    let detected = duck::detect_head(path)?;
    let encoding = options.encoding.unwrap_or(detected);
    let mut map = app.csv.large.lock().unwrap();
    match map.get(&key) {
        Some(Large::Ready(db)) => return Ok(db.schema.clone()),
        Some(Large::Running(_)) => return Ok(pending(encoding, detected)),
        Some(Large::Failed(e)) => {
            let e = e.clone();
            map.remove(&key);
            return Err(ApiError::Internal(e));
        }
        None => {}
    }
    let cfg = &app.csv.config;
    let file = db_path(app, &key);
    if let Some(db) = duck::open_cached(&file, cfg.duckdb_threads, &cfg.duckdb_memory) {
        let schema = db.schema.clone();
        map.insert(key, Large::Ready(Arc::new(db)));
        return Ok(schema);
    }
    let src = duck::Source {
        path: path.to_owned(),
        encoding,
        detected,
        delimiter: options.delimiter.as_deref().map(delimiter_of).transpose()?,
        header: options.header,
        threads: cfg.duckdb_threads,
        memory: cfg.duckdb_memory.clone(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    map.insert(key.clone(), Large::Running(cancel.clone()));
    drop(map);
    let a = app.clone();
    std::thread::spawn(move || {
        let shown = src.path.to_string_lossy().into_owned();
        let send = |done: u64, total: u64, finished: bool, error: Option<String>| {
            a.hub.broadcast(ServerEvent::CsvProgress {
                path: shown.clone(),
                done,
                total,
                finished,
                error,
            });
        };
        let _ = std::fs::create_dir_all(file.parent().unwrap());
        let r = duck::import(&src, &file, cancel.clone(), &|done, total| {
            send(done, total, false, None)
        });
        let mut map = a.csv.large.lock().unwrap();
        match r {
            Ok(db) => {
                map.insert(key, Large::Ready(Arc::new(db)));
                drop(map);
                evict(&a);
                send(1, 1, true, None);
            }
            Err(_) if cancel.load(Ordering::Relaxed) => {
                map.remove(&key);
            }
            Err(e) => {
                let msg = match e {
                    ApiError::BadRequest(m)
                    | ApiError::Forbidden(m)
                    | ApiError::NotFound(m)
                    | ApiError::Unavailable(m)
                    | ApiError::Internal(m) => m,
                };
                map.insert(key, Large::Failed(msg.clone()));
                drop(map);
                send(0, 1, false, Some(msg));
            }
        }
    });
    Ok(pending(encoding, detected))
}

/// キャッシュ(media と csv の合計)が上限を超えていたら、古いデータベースから消す。開いているものは残す
fn evict(app: &App) {
    fn files(dir: &Path) -> Vec<(SystemTime, u64, PathBuf)> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                m.is_file()
                    .then(|| (m.modified().unwrap_or(UNIX_EPOCH), m.len(), e.path()))
            })
            .collect()
    }
    let media: u64 = files(&app.cache_dir.join("media"))
        .iter()
        .map(|f| f.1)
        .sum();
    let mut csv = files(&app.cache_dir.join("csv"));
    let mut total = media + csv.iter().map(|f| f.1).sum::<u64>();
    let open: Vec<PathBuf> = app
        .csv
        .large
        .lock()
        .unwrap()
        .keys()
        .map(|k| db_path(app, k))
        .collect();
    csv.sort_by_key(|f| f.0);
    for (_, len, path) in csv {
        if total <= CACHE_LIMIT {
            break;
        }
        if !open.contains(&path) && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// 読み込みの済んだデータベース。まだなら 409
fn ready_db(app: &App, path: &Path, options: &CsvOptions) -> Result<Arc<duck::Db>, ApiError> {
    let key = Key::of(path, options)?;
    match app.csv.large.lock().unwrap().get(&key) {
        Some(Large::Ready(db)) => Ok(db.clone()),
        _ => Err(ApiError::BadRequest(
            "まだ読み込んでいません。/api/csv/schema を先に呼んでください".into(),
        )),
    }
}

/// `POST /api/csv/query`: 大規模モードのページ(16.5)
pub(crate) async fn query(
    State(app): State<Arc<App>>,
    Json(q): Json<CsvQuery>,
) -> Result<Json<CsvPage>, ApiError> {
    let path = csv_path(&app, &q.path)?;
    blocking(move || ready_db(&app, &path, &q.options)?.page(&q).map(Json)).await
}

/// `POST /api/csv/search`: 大規模モードの検索
pub(crate) async fn search(
    State(app): State<Arc<App>>,
    Json(q): Json<CsvSearch>,
) -> Result<Json<CsvMatches>, ApiError> {
    let path = csv_path(&app, &q.path)?;
    blocking(move || ready_db(&app, &path, &q.options)?.search(&q).map(Json)).await
}

#[derive(serde::Deserialize)]
pub(crate) struct LocateRequest {
    #[serde(flatten)]
    search: CsvSearch,
    row: u64,
}

/// `POST /api/csv/locate`: 元の行番号の、並べ替え・フィルター後の位置(: 行番号)
pub(crate) async fn locate(
    State(app): State<Arc<App>>,
    Json(q): Json<LocateRequest>,
) -> Result<Json<Option<u64>>, ApiError> {
    let path = csv_path(&app, &q.search.path)?;
    blocking(move || {
        ready_db(&app, &path, &q.search.options)?
            .locate(&q.search, q.row)
            .map(Json)
    })
    .await
}

/// `POST /api/csv/cancel`: 読み込み中なら止める(ウィンドウを閉じたとき。16.5)
pub(crate) async fn cancel(
    State(app): State<Arc<App>>,
    Query(q): Query<PathParam>,
) -> Result<axum::http::StatusCode, ApiError> {
    let path = csv_path(&app, &q.path)?;
    for (k, v) in app.csv.large.lock().unwrap().iter() {
        if let (true, Large::Running(flag)) = (k.path == path, v) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}
