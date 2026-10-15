//! 受け入れ基準の外にある API の振る舞い

mod common;

use common::{Instance, copy_fixtures, free_port, q};

#[test]
fn tree_lists_dirs_first_with_media_kind() {
    let root = copy_fixtures();
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        root.path().to_str().unwrap(),
    ]);

    let tree: serde_json::Value = serde_json::from_str(
        &a.get(&format!("/api/tree?path={}", q(root.path())))
            .text()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(tree["parent"], serde_json::Value::Null, "起点には親がない");
    let names: Vec<_> = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names[0], "sub");
    assert!(
        names.contains(&".hidden.png"),
        "隠しファイルの扱いはブラウザ側で決める"
    );
    let mp4 = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "h264_aac.mp4")
        .unwrap();
    assert_eq!(mp4["media"], "video");
    assert_eq!(mp4["kind"], "file");
    assert_eq!(mp4["readable"], true);

    let info: serde_json::Value =
        serde_json::from_str(&a.get("/api/info").text().unwrap()).unwrap();
    assert_eq!(
        info["home"],
        root.path().canonicalize().unwrap().to_str().unwrap(),
        "HOME が範囲外なら起点"
    );
}

#[test]
fn media_supports_range() {
    let root = copy_fixtures();
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        root.path().to_str().unwrap(),
    ]);
    let (name, value) = a.login();

    let res = common::client()
        .get(format!(
            "{}/api/media?path={}",
            a.base(),
            q(&root.path().join("h264_aac.mp4"))
        ))
        .header("cookie", format!("{name}={value}"))
        .header("range", "bytes=10-19")
        .send()
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(res.headers()["content-type"], "video/mp4");
    let full = std::fs::read(root.path().join("h264_aac.mp4")).unwrap();
    assert_eq!(res.bytes().unwrap().as_ref(), &full[10..20]);
}
