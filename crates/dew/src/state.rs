//! ~/.cache/dew/server.json: 起動中のサーバのポートとトークン(2.5)。2回目以降の dew はこれを見て再利用する

use std::path::PathBuf;

use anyhow::Context;
use serde::{Deserialize, Serialize};

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
    /// サーバを起動したときの dew の実行ファイルの更新時刻(ナノ秒)。ビルドし直したのに古いサーバが
    /// 動き続けているのを見つけるのに使う
    #[serde(default)]
    pub exe_mtime: Option<u128>,
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
