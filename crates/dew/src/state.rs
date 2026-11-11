//! ~/.cache/dew/server.json: 起動中のサーバのポートとトークン(2.5)。2回目以降の dew はこれを見て再利用する

use std::path::PathBuf;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::config::{self, Origin};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFile {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub instance_id: String,
    /// CLI から話しかけるアドレス
    pub local_host: String,
    pub url: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    /// サーバを起動したときの dew の実行ファイルの更新時刻(ナノ秒)。ビルドし直したのに古いサーバが
    /// 動き続けているのを見つけるのに使う
    #[serde(default)]
    pub exe_mtime: Option<u128>,
    /// 閲覧範囲(7.2)。起動したときと dew status で出す
    #[serde(default)]
    pub root: String,
    /// サーバを起動したときの URL のホストとポートの設定。URL と一緒に出す。前の版のサーバは記録がない
    #[serde(default)]
    pub public: Option<PublicEnv>,
}

/// URL の作り方を決める設定(環境変数 DEW_PUBLIC_HOST / DEW_PUBLIC_PORT か、dew config の host / port)。
/// 未設定・空は None。書かれたままの文字列で持つ。出どころの記録がない(前の版の)ものは環境変数
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEnv {
    pub host: Option<String>,
    pub port: Option<String>,
    #[serde(default)]
    pub host_origin: Option<Origin>,
    #[serde(default)]
    pub port_origin: Option<Origin>,
}

impl PublicEnv {
    /// 今のプロセスの環境変数と設定ファイルから決める
    pub fn current() -> Self {
        Self::resolve(&config::load())
    }

    pub fn resolve(cfg: &config::Config) -> Self {
        let (host, host_origin) = config::public_value("DEW_PUBLIC_HOST", cfg.host.clone());
        let (port, port_origin) =
            config::public_value("DEW_PUBLIC_PORT", cfg.port.map(|p| p.to_string()));
        Self {
            host,
            port,
            host_origin,
            port_origin,
        }
    }
}

/// 今の dew の実行ファイルの更新時刻(ナノ秒)
pub fn exe_mtime() -> Option<u128> {
    let m = std::env::current_exe()
        .ok()?
        .metadata()
        .ok()?
        .modified()
        .ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos())
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 起動し直しても変えない値(トークン、TLS 証明書など)の置き場所
pub fn data_dir() -> PathBuf {
    home().join(".local/share/dew")
}

pub fn cache_dir() -> PathBuf {
    home().join(".cache/dew")
}

fn path() -> PathBuf {
    cache_dir().join("server.json")
}

pub fn read() -> Option<ServerFile> {
    serde_json::from_slice(&std::fs::read(path()).ok()?).ok()
}

pub fn write(s: &ServerFile) -> anyhow::Result<()> {
    let p = path();
    std::fs::create_dir_all(p.parent().unwrap())?;
    // 書きかけを読まれないよう、別名で書いてから置き換える
    let tmp = p.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
    std::fs::rename(&tmp, &p).with_context(|| format!("{} を書けません", p.display()))
}

/// 自分が書いたものだけを消す
pub fn remove_if_owned(pid: u32) {
    if read().is_some_and(|s| s.pid == pid) {
        let _ = std::fs::remove_file(path());
    }
}
