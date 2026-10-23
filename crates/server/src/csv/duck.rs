//! 大規模モード(16.5): CSV を DuckDB のデータベースファイルに読み込み、ページ・検索・行の位置を問い合わせる。
//! 解析は小規模モードと同じもの(parse.rs)を使い、1回目で列数・型・行数を数え、2回目で流し込む。
//! 元の値は文字列(c0, c1, …)のまま入れ、数値・真偽値の列は型付きの値(n0, …)も入れる(表示とコピーは元の値)

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dew_protocol::{CsvColumn, CsvMatches, CsvPage, CsvSchema, CsvSearch, CsvType, TextEncoding};
use duckdb::types::Value;
use duckdb::{Connection, params_from_iter};
use encoding_rs::Encoding;

use super::parse::{self, Shape};
use super::sql::{self, Params};
use crate::files::ApiError;

/// 1回の問い合わせの上限(16.5)
const QUERY_LIMIT: Duration = Duration::from_secs(10);
/// 検索で返す一致の数の上限
const MAX_MATCHES: usize = 100_000;
/// 進捗を知らせる間隔
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// 文字コードを判定するのに読む先頭の大きさ
const DETECT_BYTES: u64 = 1024 * 1024;
/// データベースの形が変わったら上げる(古いキャッシュを使わないように)
const DB_VERSION: u32 = 1;

/// 読み込んだデータベース
pub(crate) struct Db {
    conn: std::sync::Mutex<Connection>,
    pub schema: CsvSchema,
}

/// 読み込みの指定(判定した値か、手動設定)
pub(crate) struct Source {
    pub path: PathBuf,
    pub encoding: TextEncoding,
    pub detected: TextEncoding,
    /// None なら判定する
    pub delimiter: Option<u8>,
    pub header: Option<bool>,
    pub threads: u32,
    pub memory: String,
}

/// 先頭から文字コードを判定する(途中で切れた UTF-8 の文字は数えない)
pub(crate) fn detect_head(path: &Path) -> Result<TextEncoding, ApiError> {
    let mut head = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(DETECT_BYTES).read_to_end(&mut head))
        .map_err(|e| ApiError::NotFound(format!("{} を読めません: {e}", path.display())))?;
    if let Err(e) = std::str::from_utf8(&head)
        && e.error_len().is_none()
    {
        head.truncate(e.valid_up_to());
    }
    Ok(crate::text::detect(&head))
}

fn encoding(e: TextEncoding) -> &'static Encoding {
    match e {
        TextEncoding::Utf8 => encoding_rs::UTF_8,
        TextEncoding::Utf16le => encoding_rs::UTF_16LE,
        TextEncoding::Utf16be => encoding_rs::UTF_16BE,
        TextEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
        TextEncoding::EucJp => encoding_rs::EUC_JP,
    }
}

/// 読みながら UTF-8 にする。読んだバイト数を数える(進捗)。止めるよう言われたら読むのをやめる
struct Decoded<R> {
    inner: R,
    decoder: encoding_rs::Decoder,
    raw: Vec<u8>,
    out: Vec<u8>,
    pos: usize,
    eof: bool,
    read: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
}

impl<R: Read> Decoded<R> {
    fn new(inner: R, e: TextEncoding, read: Arc<AtomicU64>, cancel: Arc<AtomicBool>) -> Self {
        Decoded {
            inner,
            decoder: encoding(e).new_decoder_with_bom_removal(),
            raw: vec![0; 256 * 1024],
            out: Vec::new(),
            pos: 0,
            eof: false,
            read,
            cancel,
        }
    }
}

impl<R: Read> Read for Decoded<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.out.len() {
            if self.eof {
                return Ok(0);
            }
            if self.cancel.load(Ordering::Relaxed) {
                return Err(std::io::Error::other("中断しました"));
            }
            let n = self.inner.read(&mut self.raw)?;
            self.read.fetch_add(n as u64, Ordering::Relaxed);
            self.eof = n == 0;
            let mut s =
                String::with_capacity(self.decoder.max_utf8_buffer_length(n).unwrap_or(n * 3));
            let (_, _, _) = self
                .decoder
                .decode_to_string(&self.raw[..n], &mut s, self.eof);
            self.out = s.into_bytes();
            self.pos = 0;
        }
        let n = buf.len().min(self.out.len() - self.pos);
        buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn open_conn(path: &Path, threads: u32, memory: &str) -> Result<Connection, ApiError> {
    let conn = Connection::open(path).map_err(internal)?;
    // メモリの上限は「数字 + 単位」だけを受け付ける(設定ファイルの値をそのまま SQL に入れないように)
    let memory = if valid_memory(memory) { memory } else { "1GB" };
    conn.execute_batch(&format!(
        "SET threads = {threads}; SET memory_limit = '{memory}';"
    ))
    .map_err(internal)?;
    Ok(conn)
}

/// `512MB`、`1GB`、`1.5GiB` のような大きさか
fn valid_memory(m: &str) -> bool {
    let digits = m.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let unit = &m[digits.len()..];
    !digits.is_empty()
        && digits.parse::<f64>().is_ok_and(|v| v > 0.0)
        && ["KB", "MB", "GB", "TB", "KiB", "MiB", "GiB", "TiB"]
            .iter()
            .any(|u| unit.eq_ignore_ascii_case(u))
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(e.to_string())
}

/// 前に作ったデータベースがあれば開く
pub(crate) fn open_cached(db: &Path, threads: u32, memory: &str) -> Option<Db> {
    if !db.exists() {
        return None;
    }
    let conn = open_conn(db, threads, memory).ok()?;
    let json: String = conn
        .query_row(
            "SELECT schema FROM meta WHERE version = ?",
            [DB_VERSION],
            |r| r.get(0),
        )
        .ok()?;
    let schema = serde_json::from_str(&json).ok()?;
    Some(Db {
        conn: std::sync::Mutex::new(conn),
        schema,
    })
}

/// CSV をデータベースファイルに読み込む。途中のファイルは `.tmp.` を付けて作り、できたら名前を変える
pub(crate) fn import(
    src: &Source,
    db: &Path,
    cancel: Arc<AtomicBool>,
    progress: &dyn Fn(u64, u64),
) -> Result<Db, ApiError> {
    let len = std::fs::metadata(&src.path).map_err(internal)?.len();
    let total = len.saturating_mul(2).max(1);
    let read = Arc::new(AtomicU64::new(0));
    let open = || -> Result<Decoded<std::io::BufReader<std::fs::File>>, ApiError> {
        let f = std::fs::File::open(&src.path)
            .map_err(|e| ApiError::NotFound(format!("{} を読めません: {e}", src.path.display())))?;
        Ok(Decoded::new(
            std::io::BufReader::new(f),
            src.encoding,
            read.clone(),
            cancel.clone(),
        ))
    };
    let mut last = Instant::now();
    let mut tick = |force: bool| {
        if force || last.elapsed() >= PROGRESS_EVERY {
            last = Instant::now();
            progress(read.load(Ordering::Relaxed).min(total), total);
        }
    };
    tick(true);

    // 区切り文字は先頭から判定する
    let delimiter = match src.delimiter {
        Some(d) => d,
        None => {
            let mut head = Vec::new();
            open()?
                .take(64 * 1024)
                .read_to_end(&mut head)
                .map_err(internal)?;
            read.store(0, Ordering::Relaxed);
            parse::sniff_delimiter(
                &head,
                src.path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("tsv")),
            )
        }
    };

    // 1回目: ヘッダー・列数・不揃いな行・型
    let mut rd = parse::reader(open()?, delimiter);
    let mut rec = csv::StringRecord::new();
    let mut header = None;
    let mut first_is_data = None;
    if rd.read_record(&mut rec).map_err(cancelled)? {
        let first: Vec<String> = rec.iter().map(str::to_owned).collect();
        let has = src
            .header
            .unwrap_or_else(|| parse::looks_like_header(&first));
        if has {
            header = Some(first);
        } else {
            first_is_data = Some(first);
        }
    }
    let has_header = header.is_some();
    let mut shape = Shape::new(header);
    if let Some(f) = &first_is_data {
        shape.feed(f.len(), f.iter().map(String::as_str));
    }
    while rd.read_record(&mut rec).map_err(cancelled)? {
        shape.feed(rec.len(), rec.iter());
        tick(false);
    }
    let columns = shape.columns();
    let n = columns.len();

    // 2回目: 流し込む
    let tmp = db.with_extension(format!("tmp.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let conn = open_conn(&tmp, src.threads, &src.memory)?;
    let mut defs = vec!["__row BIGINT".to_owned()];
    defs.extend((0..n).map(|i| format!("c{i} VARCHAR")));
    for (i, c) in columns.iter().enumerate() {
        if let Some(t) = sql::typed(c.ty) {
            defs.push(format!("n{i} {t}"));
        }
    }
    conn.execute_batch(&format!("CREATE TABLE t ({});", defs.join(", ")))
        .map_err(internal)?;
    {
        let mut app = conn.appender("t").map_err(internal)?;
        let mut rd = parse::reader(open()?, delimiter);
        if has_header {
            rd.read_record(&mut rec).map_err(cancelled)?;
        }
        let mut row: u64 = 0;
        let mut values: Vec<Value> = Vec::with_capacity(1 + 2 * n);
        while rd.read_record(&mut rec).map_err(cancelled)? {
            row += 1;
            values.clear();
            values.push(Value::BigInt(row as i64));
            for i in 0..n {
                values.push(match rec.get(i).filter(|v| !v.is_empty()) {
                    Some(v) => Value::Text(v.to_owned()),
                    None => Value::Null,
                });
            }
            for (i, c) in columns.iter().enumerate() {
                let v = rec.get(i).filter(|v| !v.is_empty());
                match c.ty {
                    CsvType::Integer => values.push(
                        v.and_then(|v| v.parse::<i64>().ok())
                            .map_or(Value::Null, Value::BigInt),
                    ),
                    CsvType::Float => values.push(
                        v.and_then(|v| v.parse::<f64>().ok())
                            .map_or(Value::Null, Value::Double),
                    ),
                    CsvType::Boolean => values.push(v.map_or(Value::Null, |v| {
                        Value::Boolean(v.eq_ignore_ascii_case("true"))
                    })),
                    CsvType::Date | CsvType::String => {}
                }
            }
            app.append_row(duckdb::appender_params_from_iter(values.iter()))
                .map_err(internal)?;
            tick(false);
        }
        app.flush().map_err(internal)?;
    }
    let schema = CsvSchema {
        mode: dew_protocol::CsvMode::Large,
        columns,
        encoding: src.encoding,
        detected: src.detected,
        delimiter: (delimiter as char).to_string(),
        header: has_header,
        rows: shape.rows,
        ragged: shape.ragged,
        ready: true,
    };
    conn.execute_batch("CREATE TABLE meta (version INTEGER, schema VARCHAR);")
        .map_err(internal)?;
    conn.execute(
        "INSERT INTO meta VALUES (?, ?)",
        duckdb::params![
            DB_VERSION,
            serde_json::to_string(&schema).map_err(internal)?
        ],
    )
    .map_err(internal)?;
    conn.execute_batch("CHECKPOINT;").map_err(internal)?;
    drop(conn);
    std::fs::rename(&tmp, db).map_err(internal)?;
    let _ = std::fs::remove_file(tmp.with_extension("tmp.wal"));
    tick(true);
    open_cached(db, src.threads, &src.memory)
        .ok_or_else(|| ApiError::Internal("データベースを開けません".into()))
}

fn cancelled(e: csv::Error) -> ApiError {
    ApiError::Internal(format!("読み込めませんでした: {e}"))
}

impl Db {
    /// 10 秒で打ち切る(16.5)
    fn with_limit<T>(
        &self,
        f: impl FnOnce(&Connection) -> duckdb::Result<T>,
    ) -> Result<T, ApiError> {
        let conn = self.conn.lock().unwrap();
        let handle = conn.interrupt_handle();
        let done = Arc::new(AtomicBool::new(false));
        let d = done.clone();
        std::thread::spawn(move || {
            let until = Instant::now() + QUERY_LIMIT;
            while !d.load(Ordering::Relaxed) {
                if Instant::now() >= until {
                    handle.interrupt();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let started = Instant::now();
        let r = f(&conn);
        done.store(true, Ordering::Relaxed);
        r.map_err(|e| {
            if started.elapsed() >= QUERY_LIMIT {
                ApiError::Unavailable("問い合わせが 10 秒で終わらなかったので打ち切りました".into())
            } else {
                internal(e)
            }
        })
    }

    fn columns(&self) -> &[CsvColumn] {
        &self.schema.columns
    }

    /// 並べ替え・フィルター後のページ
    pub(crate) fn page(&self, q: &dew_protocol::CsvQuery) -> Result<CsvPage, ApiError> {
        let mut p = Params::default();
        let w = sql::filters(self.columns(), &q.filters, &mut p)?;
        let order = sql::order(self.columns(), &q.sort)?;
        let n = self.columns().len();
        let limit = p.0.len() + 1;
        let page_sql = format!(
            "SELECT __row, {} FROM t WHERE {w} ORDER BY {order} LIMIT ${limit} OFFSET ${}",
            sql::value_columns(n),
            limit + 1
        );
        let count_sql = format!("SELECT count(*) FROM t WHERE {w}");
        self.with_limit(|conn| {
            let total: i64 =
                conn.query_row(&count_sql, params_from_iter(p.0.iter()), |r| r.get(0))?;
            let mut args = p.0.clone();
            args.push(Value::BigInt(i64::from(q.limit.min(5000))));
            args.push(Value::BigInt(q.offset as i64));
            let mut st = conn.prepare(&page_sql)?;
            let mut rows = Vec::new();
            let mut numbers = Vec::new();
            let mut it = st.query(params_from_iter(args.iter()))?;
            while let Some(r) = it.next()? {
                numbers.push(r.get::<_, i64>(0)? as u64);
                let mut cells = Vec::with_capacity(n);
                for i in 0..n {
                    cells.push(r.get::<_, Option<String>>(i + 1)?);
                }
                rows.push(cells);
            }
            Ok(CsvPage {
                rows,
                row_numbers: numbers,
                total: total as u64,
            })
        })
    }

    /// 検索: 並べ替え・フィルター後の位置と列(上から、左から)
    pub(crate) fn search(&self, q: &CsvSearch) -> Result<CsvMatches, ApiError> {
        let mut p = Params::default();
        let w = sql::filters(self.columns(), &q.filters, &mut p)?;
        let order = sql::order(self.columns(), &q.sort)?;
        let n = self.columns().len();
        let qp = p.0.len() + 1;
        let hits = sql::search_hits(n, &format!("${qp}"));
        let any = (0..n)
            .map(|i| format!("coalesce(contains(lower(c{i}), ${qp}), false)"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let text = format!(
            "SELECT pos, {hits} FROM (SELECT row_number() OVER (ORDER BY {order}) - 1 AS pos, * FROM t WHERE {w}) WHERE {any} ORDER BY pos LIMIT {}",
            MAX_MATCHES + 1
        );
        let mut args = p.0.clone();
        args.push(Value::Text(q.query.to_lowercase()));
        self.with_limit(|conn| {
            let mut st = conn.prepare(&text)?;
            let mut it = st.query(params_from_iter(args.iter()))?;
            let mut matches = Vec::new();
            while let Some(r) = it.next()? {
                let pos = r.get::<_, i64>(0)? as u64;
                for i in 0..n {
                    if r.get::<_, bool>(i + 1)? {
                        matches.push((pos, i as u32));
                    }
                }
            }
            let truncated = matches.len() > MAX_MATCHES;
            matches.truncate(MAX_MATCHES);
            Ok(CsvMatches { matches, truncated })
        })
    }

    /// 元の行番号 row の、並べ替え・フィルター後の位置(なければ None)
    pub(crate) fn locate(&self, q: &CsvSearch, row: u64) -> Result<Option<u64>, ApiError> {
        let mut p = Params::default();
        let w = sql::filters(self.columns(), &q.filters, &mut p)?;
        let order = sql::order(self.columns(), &q.sort)?;
        let rp = p.0.len() + 1;
        let text = format!(
            "SELECT pos FROM (SELECT row_number() OVER (ORDER BY {order}) - 1 AS pos, __row FROM t WHERE {w}) WHERE __row = ${rp}"
        );
        let mut args = p.0.clone();
        args.push(Value::BigInt(row as i64));
        self.with_limit(|conn| {
            let mut st = conn.prepare(&text)?;
            let mut it = st.query(params_from_iter(args.iter()))?;
            Ok(match it.next()? {
                Some(r) => Some(r.get::<_, i64>(0)? as u64),
                None => None,
            })
        })
    }
}
