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

/// 受信を待つ上限つきで、条件に合う通知を読む
fn recv_json(
    ws: &mut common::Ws,
    secs: u64,
    f: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let start = std::time::Instant::now();
    ws.get_mut()
        .get_mut()
        .set_read_timeout(Some(std::time::Duration::from_secs(secs)))
        .unwrap();
    loop {
        assert!(start.elapsed().as_secs() < secs, "通知が来ない");
        if let tungstenite::Message::Text(t) = ws.read().expect("通知が来ない") {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if f(&v) {
                return v;
            }
        }
    }
}

#[test]
fn app_window_is_listed_and_streamed_as_h264() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/apps/counter.py");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_dew"))
        .args([
            "run",
            "python3",
            app.to_str().unwrap(),
            "--tone",
            "0",
            "--seconds",
            "20",
        ])
        .env_clear()
        .env("HOME", a.home.path())
        .env("PATH", std::env::var("PATH").unwrap())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let mut events = a.ws("/ws/events");
    let list = recv_json(&mut events, 20, |v| {
        v["type"] == "liveWindows"
            && v["windows"]
                .as_array()
                .is_some_and(|w| w.iter().any(|w| w["title"] == "counter"))
    });
    let win = list["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["title"] == "counter")
        .unwrap()
        .clone();
    assert_eq!(
        (win["width"].as_u64(), win["height"].as_u64()),
        (Some(640), Some(360))
    );

    let mut video = a.ws(&format!("/ws/live/{}", win["id"]));
    let config = recv_json(&mut video, 10, |_| true);
    assert!(
        config["codec"].as_str().unwrap().starts_with("avc1."),
        "{config}"
    );
    // 最初のフレームはキーフレームで、続いてフレームが届き続ける
    let mut frames = 0;
    let mut first_key = None;
    while frames < 30 {
        if let tungstenite::Message::Binary(b) = video.read().unwrap() {
            first_key.get_or_insert(b[0] & 1 == 1);
            frames += 1;
        }
    }
    assert_eq!(first_key, Some(true));
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn session_audio_is_streamed_as_opus() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    // セッションを作ってから、音を鳴らすアプリを動かす
    a.dew(&["env"]);
    let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/apps/counter.py");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_dew"))
        .args([
            "run",
            "python3",
            app.to_str().unwrap(),
            "--tone",
            "440",
            "--seconds",
            "20",
        ])
        .env_clear()
        .env("HOME", a.home.path())
        .env("PATH", std::env::var("PATH").unwrap())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut ws = a.ws("/ws/live-audio");
    let config = recv_json(&mut ws, 10, |_| true);
    assert_eq!(config["codec"], "opus");
    assert_eq!(config["sampleRate"], 48000);
    // アプリが音を出し始めるまで(起動に数秒かかる)待ってから、10 ms ごとのパケットが届き続けるかを見る
    while !matches!(ws.read().unwrap(), tungstenite::Message::Binary(_)) {}
    let start = std::time::Instant::now();
    let mut packets = 0;
    let mut last_ts = None;
    while start.elapsed().as_secs_f64() < 1.5 {
        if let tungstenite::Message::Binary(b) = ws.read().unwrap() {
            let ts = u64::from_be_bytes(b[..8].try_into().unwrap());
            if let Some(prev) = last_ts {
                assert_eq!(ts - prev, 10_000, "10 ms 間隔");
            }
            last_ts = Some(ts);
            packets += 1;
        }
    }
    assert!(packets >= 100, "{packets}");
    let _ = child.kill();
    let _ = child.wait();
}

/// 起動時に作ってすぐ消すウィンドウ(pygame などで起きる)があっても、監視が止まらない
#[test]
fn short_lived_windows_do_not_stop_the_monitor() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let script = r#"
import os, time
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
import pygame
for i in range(20):
    pygame.display.init(); pygame.display.set_mode((100, 100)); pygame.display.quit()
pygame.display.init(); s = pygame.display.set_mode((320, 240)); pygame.display.set_caption("survivor")
t = time.time()
while time.time() - t < 15:
    pygame.event.pump(); s.fill((0, 0, 0)); pygame.display.flip(); time.sleep(0.03)
"#;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_dew"))
        .args(["run", "python3", "-c", script])
        .env_clear()
        .env("HOME", a.home.path())
        .env("PATH", std::env::var("PATH").unwrap())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut events = a.ws("/ws/events");
    recv_json(&mut events, 20, |v| {
        v["type"] == "liveWindows"
            && v["windows"]
                .as_array()
                .is_some_and(|w| w.iter().any(|w| w["title"] == "survivor"))
    });
    let _ = child.kill();
    let _ = child.wait();
}
