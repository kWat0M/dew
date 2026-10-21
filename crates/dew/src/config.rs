//! 設定ファイル `~/.config/dew/config.toml`(9.1)。サーバと CLI が読む設定を置く。
//! ブラウザで決まる設定(見た目、通知など)は localStorage にある。知らない項目は読み飛ばす(後の版の設定を残せるように)

use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    /// タブがないとき、URL を OSC 52 で端末のクリップボードにもコピーする(14.4。既定はオフ)
    pub open_fallback_clipboard: bool,
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
    }
}
