//! 受け入れテストの共通部品: dew を独立した HOME で起動し、HTTPS で話しかける

#![allow(dead_code)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use reqwest::blocking::{Client, Response};
use serde_json::Value;
use tempfile::TempDir;

/// tests/fixtures(scripts/gen-fixtures.sh で生成)
pub fn fixtures() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
    assert!(
        dir.join("h264_aac.mp4").exists(),
        "テスト素材がありません。scripts/gen-fixtures.sh を実行してください"
    );
    dir.canonicalize().unwrap()
}

/// テスト素材を一時ディレクトリに複製する(監視や --root のテストで書き換えるため)
pub fn copy_fixtures() -> TempDir {
    let dir = TempDir::new().unwrap();
    let status = Command::new("cp")
        .arg("-a")
        .arg(format!("{}/.", fixtures().display()))
        .arg(dir.path())
        .status()
        .unwrap();
    assert!(status.success());
    dir
}

/// 使われていないポートを1つ選ぶ(テストを並列に動かすため、既定の 8765 は使わない)
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// HOME を分けた dew の1インスタンス(1つのコンテナに相当)。Drop で `dew stop` する
pub struct Instance {
    pub home: TempDir,
}

impl Instance {
    pub fn new() -> Self {
        Self {
            home: TempDir::new().unwrap(),
        }
    }

    /// dew を実行して終わるまで待つ。環境変数は開発コンテナのものを持ち込まない
    pub fn dew(&self, args: &[&str]) -> Output {
        let out = Command::new(env!("CARGO_BIN_EXE_dew"))
            .args(args)
            .env_clear()
            .env("HOME", self.home.path())
            .env("PATH", std::env::var("PATH").unwrap())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "dew {args:?} が失敗しました\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    /// ~/.cache/dew/server.json(起動中のサーバのポートとトークン)
    pub fn server_json(&self) -> Value {
        let path = self.home.path().join(".cache/dew/server.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} を読めません: {e}", path.display()));
        serde_json::from_str(&text).unwrap()
    }

    pub fn port(&self) -> u16 {
        self.server_json()["port"].as_u64().unwrap() as u16
    }

    pub fn token(&self) -> String {
        self.server_json()["token"].as_str().unwrap().to_owned()
    }

    pub fn base(&self) -> String {
        format!("https://127.0.0.1:{}", self.port())
    }

    /// トークン付き URL を開いて Cookie を受け取る。返り値は (Cookie 名, 値)
    pub fn login(&self) -> (String, String) {
        let res = client()
            .get(format!("{}/?token={}", self.base(), self.token()))
            .send()
            .unwrap();
        assert!(
            res.status().is_redirection(),
            "トークンを Cookie に移したらリダイレクトする"
        );
        let set_cookie = res.headers()["set-cookie"].to_str().unwrap().to_owned();
        let pair = set_cookie.split(';').next().unwrap();
        let (name, value) = pair.split_once('=').unwrap();
        (name.to_owned(), value.to_owned())
    }

    /// ログイン済みで GET する
    pub fn get(&self, path_and_query: &str) -> Response {
        let (name, value) = self.login();
        client()
            .get(format!("{}{path_and_query}", self.base()))
            .header("cookie", format!("{name}={value}"))
            .send()
            .unwrap()
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_dew"))
            .arg("stop")
            .env_clear()
            .env("HOME", self.home.path())
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .output();
    }
}

/// 自己署名証明書を受け入れ、リダイレクトは追わないクライアント
pub fn client() -> Client {
    Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap()
}

/// 端末出力から https://…?token=… の URL を取り出す(OSC 8 のエスケープを含んでいてもよい)
pub fn find_url(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let start = text.find("https://")?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '\x1b' || c == '\x07')
        .unwrap_or(rest.len());
    Some(rest[..end].to_owned())
}

/// URL をパーセントエンコードしたクエリ値にする
pub fn q(path: &Path) -> String {
    let s = path.to_str().unwrap();
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 条件が満たされるまで待つ
pub fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}
