//! サーバを起動し直しても変えない値(13.6、14.2)。`~/.local/share/dew/` に置く
//!
//! - `token`: トークン(権限 600)。`dew rotate-token` で作り直す
//! - `state.json`: インスタンス ID(Cookie 名に使う)、前回の待ち受けポートと仮想ディスプレイ番号。
//!   server.json は止めると消えるので、こちらに残す(ADR 0023)

use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(default)]
    instance_id: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    display: Option<u32>,
}

/// 保存した値。書き換えはこの型を通す(同じサーバの中で読み書きが重ならないように)
pub(crate) struct Store {
    dir: PathBuf,
    state: Mutex<State>,
}

impl Store {
    pub(crate) fn open(dir: &Path) -> Self {
        let state = std::fs::read(dir.join("state.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            dir: dir.to_owned(),
            state: Mutex::new(state),
        }
    }

    /// 保存したトークン。なければ作って保存する
    pub(crate) fn token(&self) -> String {
        match read_token(&self.dir) {
            Some(t) => t,
            None => rotate_token(&self.dir).unwrap_or_else(|e| {
                tracing::warn!("トークンを保存できません(このサーバの間だけ使います): {e:#}");
                crate::random_hex(32)
            }),
        }
    }

    /// 保存したインスタンス ID。なければ作って保存する
    pub(crate) fn instance_id(&self) -> String {
        let mut s = self.state.lock().unwrap();
        if let Some(id) = &s.instance_id {
            return id.clone();
        }
        let id = crate::random_hex(4);
        s.instance_id = Some(id.clone());
        self.save(&s);
        id
    }

    pub(crate) fn port(&self) -> Option<u16> {
        self.state.lock().unwrap().port
    }

    pub(crate) fn display(&self) -> Option<u32> {
        self.state.lock().unwrap().display
    }

    pub(crate) fn set_port(&self, port: u16) {
        let mut s = self.state.lock().unwrap();
        s.port = Some(port);
        self.save(&s);
    }

    pub(crate) fn set_display(&self, display: u32) {
        let mut s = self.state.lock().unwrap();
        s.display = Some(display);
        self.save(&s);
    }

    pub(crate) fn rotate_token(&self) -> anyhow::Result<String> {
        rotate_token(&self.dir)
    }

    fn save(&self, s: &State) {
        let write = || -> anyhow::Result<()> {
            std::fs::create_dir_all(&self.dir)?;
            let path = self.dir.join("state.json");
            let tmp = path.with_extension(format!("json.{}", std::process::id()));
            std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
            std::fs::rename(&tmp, &path)?;
            Ok(())
        };
        if let Err(e) = write() {
            tracing::warn!("{} を書けません: {e:#}", self.dir.display());
        }
    }
}

fn read_token(dir: &Path) -> Option<String> {
    let t = std::fs::read_to_string(dir.join("token")).ok()?;
    let t = t.trim();
    (t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())).then(|| t.to_owned())
}

/// 新しいトークンを作って保存する(権限 600)。サーバが止まっているときは CLI からも呼ぶ
pub fn rotate_token(dir: &Path) -> anyhow::Result<String> {
    let token = crate::random_hex(32);
    std::fs::create_dir_all(dir)?;
    let path = dir.join("token");
    let tmp = dir.join(format!("token.{}", std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(format!("{token}\n").as_bytes())?;
    // 前からあったファイルの権限が広くても 600 にする
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&tmp, &path)?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let a = Store::open(dir.path());
        let token = a.token();
        let id = a.instance_id();
        a.set_port(9000);
        a.set_display(123);
        let b = Store::open(dir.path());
        assert_eq!(b.token(), token);
        assert_eq!(b.instance_id(), id);
        assert_eq!(b.port(), Some(9000));
        assert_eq!(b.display(), Some(123));
        let mode = std::fs::metadata(dir.path().join("token"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let new = b.rotate_token().unwrap();
        assert_ne!(new, token);
        assert_eq!(Store::open(dir.path()).token(), new);
    }
}
