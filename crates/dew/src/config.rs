//! 設定ファイル `~/.config/dew/config.toml`(9.1)。サーバと CLI が読む設定を置く。
//! ブラウザで決まる設定(見た目、通知など)は localStorage にある。知らない項目は読み飛ばす(後の版の設定を残せるように)

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct Config {
    /// タブがないとき、URL を OSC 52 で端末のクリップボードにもコピーする(14.4。既定はオフ)
    pub open_fallback_clipboard: bool,
    /// CSV: この大きさ(バイト)以上か、この行数以上なら大規模モード(16.1)
    pub csv_small_max_bytes: u64,
    pub csv_small_max_rows: u64,
    /// 大規模モードの DuckDB のスレッド数とメモリの上限(16.5)
    pub duckdb_threads: u32,
    pub duckdb_memory: String,
    /// URL のホストとポート(`dew config host` / `dew config port`)。環境変数 DEW_PUBLIC_HOST / DEW_PUBLIC_PORT が優先
    pub host: Option<String>,
    pub port: Option<u16>,
}

impl Default for Config {
    fn default() -> Self {
        let csv = dew_server::CsvConfig::default();
        Config {
            open_fallback_clipboard: false,
            csv_small_max_bytes: csv.small_max_bytes,
            csv_small_max_rows: csv.small_max_rows,
            duckdb_threads: csv.duckdb_threads,
            duckdb_memory: csv.duckdb_memory,
            host: None,
            port: None,
        }
    }
}

impl Config {
    pub fn csv(&self) -> dew_server::CsvConfig {
        dew_server::CsvConfig {
            small_max_bytes: self.csv_small_max_bytes,
            small_max_rows: self.csv_small_max_rows,
            duckdb_threads: self.duckdb_threads.max(1),
            duckdb_memory: self.duckdb_memory.clone(),
        }
    }
}

pub fn path() -> std::path::PathBuf {
    crate::state::home().join(".config/dew/config.toml")
}

/// 読めなければ既定値。書き方が違うときは知らせる(止めはしない)
pub fn load() -> Config {
    let p = path();
    let Ok(text) = std::fs::read_to_string(&p) else {
        return Config::default();
    };
    match toml::from_str(&text) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "dew: 注意: {} を読めないので既定の設定で動きます: {e}",
                p.display()
            );
            Config::default()
        }
    }
}

/// 書き方の正しさを確かめながら読む(`dew config` 用。ファイルがなければ空)
pub fn read_table() -> anyhow::Result<toml::Table> {
    let p = path();
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(toml::Table::new()),
        Err(e) => return Err(e).with_context(|| format!("{} を読めません", p.display())),
    };
    toml::from_str(&text).with_context(|| {
        format!(
            "{} の書き方が正しくありません。dew config --edit で直してください",
            p.display()
        )
    })
}

/// URL のホストやポートの値が、どこで決まったか
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Env,
    File,
}

/// URL のホストかポートの値と出どころ。環境変数が設定ファイルより優先。
/// 空の環境変数は「未設定」として設定ファイルも見ない(`DEW_PUBLIC_HOST= dew` で localhost にできるように)
pub fn public_value(env: &str, file: Option<String>) -> (Option<String>, Option<Origin>) {
    match std::env::var(env) {
        Ok(v) if v.is_empty() => (None, Some(Origin::Env)),
        Ok(v) => (Some(v), Some(Origin::Env)),
        Err(_) => match file {
            Some(v) => (Some(v), Some(Origin::File)),
            None => (None, None),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_known_keys_and_ignores_others() {
        let c: Config = toml::from_str("open_fallback_clipboard = true\n[csv]\nx = 1\n").unwrap();
        assert!(c.open_fallback_clipboard);
        let c: Config = toml::from_str("").unwrap();
        assert!(!c.open_fallback_clipboard);
        assert_eq!(c.csv_small_max_rows, 200_000);
        let c: Config = toml::from_str("csv_small_max_rows = 100\n").unwrap();
        assert_eq!(c.csv().small_max_rows, 100);
        assert_eq!(c.csv().small_max_bytes, 20 * 1024 * 1024);
        let c: Config = toml::from_str("host = \"192.0.2.10\"\nport = 18765\n").unwrap();
        assert_eq!(c.host.as_deref(), Some("192.0.2.10"));
        assert_eq!(c.port, Some(18765));
    }
}
