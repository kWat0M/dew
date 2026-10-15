//! /ws/events: ディレクトリの変更通知(基準7のサーバ側)と、CLI からの表示指示(F10)

mod common;

use std::time::{Duration, Instant};

use common::{Instance, Ws, copy_fixtures, find_url, free_port};
use serde_json::{Value, json};
use tungstenite::Message;

fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).unwrap();
}

/// 条件に合う通知が来るまで読む
fn recv_until(ws: &mut Ws, f: impl Fn(&Value) -> bool) -> Value {
    loop {
        match ws.read().expect("通知が来ない") {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if f(&v) {
                    return v;
                }
            }
            _ => continue,
        }
    }
}

#[test]
fn new_file_is_notified_within_a_second() {
    let root = copy_fixtures();
    let dir = root.path().canonicalize().unwrap();
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        dir.to_str().unwrap(),
    ]);
    let mut ws = a.ws("/ws/events");
    send(&mut ws, json!({ "type": "watch", "dirs": [dir] }));
    std::thread::sleep(Duration::from_millis(200)); // 監視の登録を待つ

    let start = Instant::now();
    std::fs::copy(dir.join("image.png"), dir.join("new.png")).unwrap();
    let ev = recv_until(&mut ws, |v| v["name"] == "new.png");
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "{:?}",
        start.elapsed()
    );
    assert_eq!(ev["type"], "dirChanged");
    assert_eq!(ev["dir"], dir.to_str().unwrap());
}

#[test]
fn dew_file_is_sent_to_last_active_tab() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let file = common::fixtures().join("h264_aac.mp4");

    let mut first = a.ws("/ws/events");
    let mut second = a.ws("/ws/events");
    send(&mut second, json!({ "type": "active" }));
    std::thread::sleep(Duration::from_millis(50));
    send(&mut first, json!({ "type": "active" }));
    std::thread::sleep(Duration::from_millis(100));

    let out = a.dew(&[file.to_str().unwrap()]);
    assert!(
        find_url(&out.stdout).is_none(),
        "タブに届いたら URL は出さない"
    );
    let ev = recv_until(&mut first, |v| v["type"] == "open");
    assert_eq!(ev["path"], file.to_str().unwrap());
    // もう一方のタブには送らない
    second
        .get_mut()
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(300)))
        .unwrap();
    assert!(second.read().is_err());
}

#[test]
fn ws_rejects_other_origin() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let (name, value) = a.login();
    let res = common::client()
        .get(format!("{}/ws/events", a.base()))
        .header("cookie", format!("{name}={value}"))
        .header("origin", "https://evil.example")
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .unwrap();
    assert_eq!(res.status(), 403);
}
