//! 何も入っていない環境(ffmpeg・Xvfb・pulseaudio がない)で、dew が足りないものと入れ方を知らせる(7.10)

use std::path::Path;
use std::process::Command;

/// PATH に sh と python3 だけを置いた環境で dew を動かす
fn bare(args: &[&str]) -> (bool, String) {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for c in ["sh", "python3"] {
        let real = which(c);
        std::os::unix::fs::symlink(real, bin.join(c)).unwrap();
    }
    let out = Command::new(env!("CARGO_BIN_EXE_dew"))
        .args(args)
        .env_clear()
        .env("HOME", dir.path())
        .env("PATH", &bin)
        .output()
        .unwrap();
    let text =
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    (out.status.success(), text)
}

fn which(cmd: &str) -> std::path::PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|d| d.join(cmd))
        .find(|p| Path::new(p).exists())
        .unwrap()
}

#[test]
fn doctor_lists_missing_and_install_command() {
    let (_, out) = bare(&["doctor"]);
    assert!(out.contains("✗ ffmpeg"), "{out}");
    assert!(
        out.contains("sudo apt-get install -y ffmpeg xvfb pulseaudio"),
        "{out}"
    );
}

#[test]
fn run_without_live_deps_explains_how_to_install() {
    let (ok, out) = bare(&["run", "python3", "-c", "print(1)"]);
    assert!(!ok);
    assert!(out.contains("ライブ描画に要る"), "{out}");
    assert!(
        out.contains("sudo apt-get install -y ffmpeg xvfb pulseaudio"),
        "{out}"
    );
    // サーバは起動しない(足りないものを先に知らせる)
    assert!(!out.contains("https://"), "{out}");
}
