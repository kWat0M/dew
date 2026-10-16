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
    // ディレクトリが先(p2/ と sub/)、続いてファイルが名前順
    let kinds: Vec<_> = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    let first_file = kinds.iter().position(|k| *k == "file").unwrap();
    assert!(
        kinds[..first_file].iter().all(|k| *k == "dir")
            && kinds[first_file..].iter().all(|k| *k == "file")
    );
    assert!(names[..first_file].contains(&"sub"));
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

#[test]
fn probe_thumb_sprite_and_segment_times() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let fx = common::fixtures();

    let probe: serde_json::Value = serde_json::from_str(
        &a.get(&format!("/api/probe?path={}", q(&fx.join("h264_aac.mp4"))))
            .text()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(probe["needsTranscode"], false);
    assert_eq!(probe["frameTimes"].as_array().unwrap().len(), 300);
    assert_eq!(probe["segmentCount"], 2);
    assert_eq!(probe["sprite"]["tileWidth"], 160);
    let probe: serde_json::Value = serde_json::from_str(
        &a.get(&format!("/api/probe?path={}", q(&fx.join("xvid_mp3.avi"))))
            .text()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(probe["needsTranscode"], true);

    for (api, name) in [
        ("thumb", "image.png"),
        ("thumb", "h264_aac.mp4"),
        ("sprite", "h264_aac.mp4"),
    ] {
        let res = a.get(&format!("/api/{api}?path={}", q(&fx.join(name))));
        assert_eq!(res.status(), 200, "{api} {name}");
        assert_eq!(res.headers()["content-type"], "image/webp");
        assert_eq!(&res.bytes().unwrap()[8..12], b"WEBP");
    }

    // 2番目のセグメントは元の動画の 6 秒の位置からの 4 秒分。時刻は 0 から並ぶ
    // (ブラウザが timestampOffset で 6 秒の位置に置く)
    let res = a.get(&format!(
        "/api/media?path={}&transcode=1&seg=1",
        q(&fx.join("mp4v.mp4"))
    ));
    assert_eq!(res.status(), 200);
    let work = tempfile::TempDir::new().unwrap();
    let seg = work.path().join("seg1.mp4");
    std::fs::write(&seg, res.bytes().unwrap()).unwrap();
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time",
            "-of",
            "csv=p=0",
        ])
        .arg(&seg)
        .output()
        .unwrap();
    let mut times: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.parse().ok())
        .collect();
    times.sort_by(f64::total_cmp);
    for (i, t) in times.iter().take(5).enumerate() {
        assert!((t - i as f64 / 30.0).abs() < 0.002, "{i} 番目 {t}");
    }
    assert_eq!(times.len(), 120, "6〜10 秒の 120 フレーム");
}
