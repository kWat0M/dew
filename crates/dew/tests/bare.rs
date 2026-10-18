//! 何も入っていない環境(ffmpeg・Xvfb・pulseaudio がない)でも、ツールの要らない機能は動き、
//! 使えない機能は、何が足りないかと入れ方を知らせる(7.10、ADR 0019)

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::{Instance, client, free_port};

/// sh・kill・python3 だけを置いた PATH 用のディレクトリ
fn bare_bin(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir(&bin).unwrap();
    for c in ["sh", "kill", "python3"] {
        std::os::unix::fs::symlink(which(c), bin.join(c)).unwrap();
    }
    bin
}

fn which(cmd: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|d| d.join(cmd))
        .find(|p| p.exists())
        .unwrap()
}

fn bare(args: &[&str]) -> (bool, String) {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_dew"))
        .args(args)
        .env_clear()
        .env("HOME", dir.path())
        .env("PATH", bare_bin(dir.path()))
        .output()
        .unwrap();
    let text =
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    (out.status.success(), text)
}

#[test]
fn doctor_lists_features_and_install_command() {
    let (_, out) = bare(&["doctor"]);
    assert!(out.contains("✓ ファイルの閲覧・再生"), "{out}");
    assert!(out.contains("✗ ライブ描画(dew run / dew env)"), "{out}");
    assert!(out.contains("✗ ffprobe"), "{out}");
    assert!(
        out.contains("sudo apt-get install -y ffmpeg xvfb pulseaudio"),
        "{out}"
    );
}

#[test]
fn run_without_live_deps_explains_how_to_install() {
    let (ok, out) = bare(&["run", "python3", "-c", "print(1)"]);
    assert!(!ok);
    assert!(out.contains("ライブ描画(dew run / dew env)に要る"), "{out}");
    assert!(out.contains("sudo apt-get install -y xvfb ffmpeg"), "{out}");
    // サーバは起動しない(足りないものを先に知らせる)
    assert!(!out.contains("https://"), "{out}");
}

/// ツールがなくても起動し、使えない機能を知らせる。動画の情報は「ffprobe がない」と分かる形で返り、
/// 録画は始める前に断る
#[test]
fn server_starts_and_reports_missing_tools() {
    let dir = tempfile::tempdir().unwrap();
    let a = Instance::with_path(&bare_bin(dir.path()));
    let root = common::copy_fixtures();
    let out = a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        root.path().to_str().unwrap(),
    ]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("使えない機能: ライブ描画"), "{err}");
    assert!(err.contains("ファイルの閲覧と再生はできます"), "{err}");

    let q = |p: &Path| urlencode(&p.to_string_lossy());
    let probe: serde_json::Value = a
        .get(&format!(
            "/api/probe?path={}",
            q(&root.path().join("h264_aac.mp4"))
        ))
        .json()
        .unwrap();
    assert_eq!(probe["missing"], serde_json::json!(["ffprobe", "ffmpeg"]));
    assert_eq!(probe["needsTranscode"], false);
    // 元のファイルはそのまま配る(ブラウザが再生する)
    assert!(
        a.get(&format!(
            "/api/media?path={}",
            q(&root.path().join("h264_aac.mp4"))
        ))
        .status()
        .is_success()
    );
    // サムネイルは、足りないツールと入れ方を返す
    let thumb = a.get(&format!(
        "/api/thumb?path={}",
        q(&root.path().join("image.png"))
    ));
    assert_eq!(thumb.status(), 503);
    assert!(
        thumb
            .text()
            .unwrap()
            .contains("サムネイルには ffmpeg が要ります")
    );

    let (name, value) = a.login();
    let rec = client()
        .post(format!("{}/api/live/record", a.base()))
        .header("cookie", format!("{name}={value}"))
        .json(&serde_json::json!({ "window": 1, "on": true }))
        .send()
        .unwrap();
    assert_eq!(rec.status(), 503);
    assert!(rec.text().unwrap().contains("録画には ffmpeg が要ります"));
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
