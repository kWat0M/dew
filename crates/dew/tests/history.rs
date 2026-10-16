//! 履歴(4.4): 直近 10 ファイルを新しい順に、閲覧範囲の起点からの相対パスで返す

mod common;

use common::{Instance, client, copy_fixtures, free_port};
use serde_json::{Value, json};

fn history(a: &Instance) -> Value {
    serde_json::from_str(&a.get("/api/history").text().unwrap()).unwrap()
}

fn add(a: &Instance, paths: &[String]) {
    let (name, value) = a.login();
    let res = client()
        .post(format!("{}/api/history", a.base()))
        .header("cookie", format!("{name}={value}"))
        .header("content-type", "application/json")
        .body(json!({ "paths": paths }).to_string())
        .send()
        .unwrap();
    assert_eq!(res.status(), 200);
}

#[test]
fn keeps_ten_newest_without_duplicates() {
    let root = copy_fixtures();
    let r = root.path().canonicalize().unwrap();
    for i in 0..12 {
        std::fs::copy(r.join("image.png"), r.join(format!("f{i:02}.png"))).unwrap();
    }
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        r.to_str().unwrap(),
    ]);

    let p = |n: &str| r.join(n).to_string_lossy().into_owned();
    for i in 0..12 {
        add(&a, &[p(&format!("f{i:02}.png"))]);
    }
    add(&a, &[p("sub/nested.webp"), p("f05.png")]);

    let h = history(&a);
    assert_eq!(h["root"], r.to_str().unwrap());
    let names: Vec<_> = h["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names.len(), 10);
    assert_eq!(
        &names[..3],
        ["f05.png", "sub/nested.webp", "f11.png"],
        "新しい順で、重複は1つにまとめる"
    );
    assert!(!names.contains(&"f01.png".to_owned()), "古いものから消える");
    assert_eq!(h["entries"][1]["media"], "image");

    // 消えたファイルは出さない。サーバを起動し直しても残る
    std::fs::remove_file(r.join("f11.png")).unwrap();
    let h = history(&a);
    assert!(
        !h["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "f11.png")
    );
    assert!(a.home.path().join(".cache/dew/history.json").exists());
}

#[test]
fn rejects_paths_outside_root() {
    let root = copy_fixtures();
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        root.path().to_str().unwrap(),
    ]);
    let (name, value) = a.login();
    let res = client()
        .post(format!("{}/api/history", a.base()))
        .header("cookie", format!("{name}={value}"))
        .header("content-type", "application/json")
        .body(json!({ "paths": ["/etc/passwd"] }).to_string())
        .send()
        .unwrap();
    assert_eq!(res.status(), 403);
}
