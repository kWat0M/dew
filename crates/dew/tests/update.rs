//! `dew update`(3.1、7.10): 偽のリリース(python の http.server で配る)から、新しい版に入れ替わる

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `root` を http で配る
fn serve(root: &Path) -> Server {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let child = Command::new("python3")
        .args([
            "-m",
            "http.server",
            &port.to_string(),
            "--bind",
            "127.0.0.1",
        ])
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "http.server が起動しません"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    Server { child, port }
}

/// 版 `tag` のリリース(中の dew は「dew <版>」と出すだけのスクリプト)を `root` に置く
fn fake_release(root: &Path, port: u16, tag: &str, break_sum: bool) {
    let ver = tag.trim_start_matches('v');
    let name = format!("dew-{ver}-abcdef0-x86_64-linux");
    let dir = root.join("build").join(&name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("dew"), format!("#!/bin/sh\necho dew {ver}\n")).unwrap();
    let sum = Command::new("sha256sum")
        .arg("dew")
        .current_dir(&dir)
        .output()
        .unwrap()
        .stdout;
    let sum = if break_sum {
        sum.iter()
            .map(|&b| if b == b'0' { b'1' } else { b })
            .collect()
    } else {
        sum
    };
    std::fs::write(dir.join("SHA256SUMS"), sum).unwrap();
    let tarball = format!("{name}.tar.gz");
    assert!(
        Command::new("tar")
            .args(["-czf", &format!("../{tarball}"), &name])
            .current_dir(root.join("build"))
            .status()
            .unwrap()
            .success()
    );
    let api = root.join("repos/me/dew/releases");
    std::fs::create_dir_all(&api).unwrap();
    let json = serde_json::json!({
        "tag_name": tag,
        "assets": [{ "name": tarball, "browser_download_url": format!("http://127.0.0.1:{port}/{tarball}") }],
    });
    std::fs::write(api.join("latest"), json.to_string()).unwrap();
}

/// 今の dew の写しを置き、それに dew update させる
fn update(root: &Path, port: u16) -> (bool, String, PathBuf) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let dew = bin.join("dew");
    std::fs::copy(env!("CARGO_BIN_EXE_dew"), &dew).unwrap();
    let out = Command::new(&dew)
        .arg("update")
        .env("HOME", root)
        .env("DEW_UPDATE_API", format!("http://127.0.0.1:{port}"))
        .env("DEW_UPDATE_REPO", "me/dew")
        .output()
        .unwrap();
    let text =
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    (out.status.success(), text, dew)
}

#[test]
fn updates_to_newer_release() {
    let root = tempfile::tempdir().unwrap();
    let srv = serve(root.path());
    fake_release(root.path(), srv.port, "v9.9.9", false);
    let (ok, out, dew) = update(root.path(), srv.port);
    assert!(ok, "{out}");
    assert!(out.contains("v9.9.9 に更新しました"), "{out}");
    let v = Command::new(&dew).output().unwrap().stdout;
    assert_eq!(String::from_utf8_lossy(&v).trim(), "dew 9.9.9");
}

#[test]
fn keeps_current_when_latest() {
    let root = tempfile::tempdir().unwrap();
    let srv = serve(root.path());
    fake_release(
        root.path(),
        srv.port,
        &format!("v{}", env!("CARGO_PKG_VERSION")),
        false,
    );
    let (ok, out, dew) = update(root.path(), srv.port);
    assert!(ok, "{out}");
    assert!(out.contains("最新です"), "{out}");
    assert_eq!(
        std::fs::read(&dew).unwrap(),
        std::fs::read(env!("CARGO_BIN_EXE_dew")).unwrap()
    );
}

#[test]
fn refuses_broken_download() {
    let root = tempfile::tempdir().unwrap();
    let srv = serve(root.path());
    fake_release(root.path(), srv.port, "v9.9.9", true);
    let (ok, out, dew) = update(root.path(), srv.port);
    assert!(!ok, "{out}");
    assert!(out.contains("SHA256SUMS と合いません"), "{out}");
    // 入れ替えていない
    assert_eq!(
        std::fs::read(&dew).unwrap(),
        std::fs::read(env!("CARGO_BIN_EXE_dew")).unwrap()
    );
}
