//! 設定ファイル `~/.config/dew/config.toml`(9.1)。サーバと CLI が読む設定を置く。
//! ブラウザで決まる設定(見た目、通知など)は localStorage にある。知らない項目は読み飛ばす(後の版の設定を残せるように)

use serde::Deserialize;

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
    }
}
