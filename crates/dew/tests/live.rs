//! フェーズ3: dew run / dew env(仮想ディスプレイと音声サーバを用意して、アプリにつなぐ)

mod common;

use common::{Instance, free_port};

#[test]
fn dew_run_gives_app_a_virtual_display_and_audio() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    // アプリの代わりにシェルで、渡された DISPLAY と PULSE_SERVER が使えることを確かめる
    let script = r#"echo "DISPLAY=$DISPLAY"; echo "PULSE=$PULSE_SERVER"; xdpyinfo | grep -m1 dimensions; pactl info | grep -m1 'Default Sink'; exit 7"#;
    let out = a.try_dew_in(std::path::Path::new("/"), &["run", "sh", "-c", script]);
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(7),
        "アプリの終了コードをそのまま返す\n{text}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let display: u32 = text
        .lines()
        .find_map(|l| l.strip_prefix("DISPLAY=:"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(display >= 100, "{text}");
    assert!(
        text.contains("3840x2160"),
        "仮想ディスプレイは 3840x2160\n{text}"
    );
    assert!(text.contains("PULSE=unix:"), "{text}");
    assert!(
        text.contains("Default Sink"),
        "音声サーバにつながる\n{text}"
    );

    // 2回目も同じセッション(同じ仮想ディスプレイ)を使う
    let out = a.try_dew_in(
        std::path::Path::new("/"),
        &["run", "sh", "-c", "echo $DISPLAY"],
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        format!(":{display}")
    );
}

#[test]
fn dew_env_prints_shell_settings() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let out = a.dew(&["env"]);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("export DISPLAY=:"), "{text}");
    assert!(text.contains("export PULSE_SERVER=unix:"), "{text}");
    // Wayland ではなく仮想ディスプレイ(X11)に出させる
    assert!(text.contains("unset WAYLAND_DISPLAY"), "{text}");
    // eval で使えること
    let check = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{text}\nxdpyinfo >/dev/null && echo ok"))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&check.stdout).trim(), "ok");
}

#[test]
fn stopping_server_stops_xvfb_and_pulseaudio() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let out = a.dew(&["env"]);
    let text = String::from_utf8_lossy(&out.stdout);
    let display = text
        .lines()
        .find_map(|l| l.strip_prefix("export DISPLAY="))
        .unwrap()
        .trim()
        .to_owned();
    a.dew(&["stop"]);
    let check = std::process::Command::new("xdpyinfo")
        .args(["-display", &display])
        .output()
        .unwrap();
    assert!(
        !check.status.success(),
        "サーバを止めたら仮想ディスプレイも止まる"
    );
}
