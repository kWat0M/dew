//! フェーズ1の受け入れ基準(docs/spec.md 11章)のうち、サーバと CLI で確かめられるもの。
//! UI の基準(Home のキー操作、再生、コマ送り、新規ファイルの表示)は tests/e2e にある。
//! 未実装の基準は #[ignore] にしておき、実装したステップで外す

mod common;

use std::process::Command;

use common::{Instance, client, copy_fixtures, find_url, fixtures, free_port, q};

// 基準1: `dew` で起動し、端末にトークン付きの HTTPS URL が表示される
#[test]
#[ignore = "S3 で実装"]
fn dew_prints_https_url_with_token() {
    let a = Instance::new();
    let port = free_port().to_string();
    let out = a.dew(&["--port", &port]);

    let url = find_url(&out.stdout).expect("URL が表示される");
    assert!(url.contains(&format!("?token={}", a.token())), "URL: {url}");
    assert!(url.contains(&format!(":{}", a.port())), "URL: {url}");
    // OSC 8 ハイパーリンクで表示する
    assert!(String::from_utf8_lossy(&out.stdout).contains("\x1b]8;;https://"));
    // バックグラウンドで動き続けている
    assert!(client().get(a.base()).send().is_ok());
}

// 基準1: 2回目の `dew <ファイル>` は既存サーバを再利用する
#[test]
#[ignore = "S3 で実装"]
fn second_dew_reuses_running_server() {
    let a = Instance::new();
    let port = free_port().to_string();
    a.dew(&["--port", &port]);
    let first = a.server_json();

    let file = fixtures().join("h264_aac.mp4");
    let out = a.dew(&[file.to_str().unwrap()]);

    let second = a.server_json();
    assert_eq!(first["pid"], second["pid"], "サーバを起動し直さない");
    assert_eq!(first["port"], second["port"]);
    assert_eq!(first["token"], second["token"]);
    // 接続中のタブがないときは URL を表示する(8.2)
    let url = find_url(&out.stdout).expect("URL が表示される");
    assert!(url.contains(&format!("?token={}", a.token())));
}

// 基準2: トークンなしのアクセスは 401 になる
#[test]
#[ignore = "S3 で実装"]
fn request_without_token_is_401() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let tree = format!("/api/tree?path={}", q(&fixtures()));

    for path in ["/", tree.as_str(), "/?token=wrong"] {
        let res = client().get(format!("{}{path}", a.base())).send().unwrap();
        assert_eq!(res.status(), 401, "{path}");
    }
    // トークンを Cookie に移した後は通る
    assert_eq!(a.get(&tree).status(), 200);
}

// 基準2: Cookie には HttpOnly・Secure・SameSite=Strict が付き、リダイレクトで URL からトークンを消す(7.8)
#[test]
#[ignore = "S3 で実装"]
fn token_moves_to_cookie() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let res = client()
        .get(format!("{}/?token={}", a.base(), a.token()))
        .send()
        .unwrap();
    assert!(res.status().is_redirection());
    assert_eq!(res.headers()["location"], "/");
    let cookie = res.headers()["set-cookie"].to_str().unwrap();
    for attr in ["HttpOnly", "Secure", "SameSite=Strict"] {
        assert!(cookie.contains(attr), "{cookie}");
    }
}

// 基準2: `--root` 指定時、範囲外のパス(`../` など)は 403 になる
#[test]
#[ignore = "S4 で実装"]
fn path_outside_root_is_403() {
    let root = copy_fixtures();
    let r = root.path();
    std::os::unix::fs::symlink("/etc", r.join("link_out")).unwrap();
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        r.to_str().unwrap(),
    ]);

    assert_eq!(a.get(&format!("/api/tree?path={}", q(r))).status(), 200);
    assert_eq!(
        a.get(&format!("/api/media?path={}", q(&r.join("image.png"))))
            .status(),
        200
    );

    let outside = [
        format!("/api/tree?path={}", q(&r.join(".."))),
        format!("/api/tree?path={}", q(&r.join("sub/../.."))),
        "/api/tree?path=..".to_owned(),
        "/api/tree?path=%2Fetc".to_owned(),
        format!("/api/media?path={}", q(&r.join("../../etc/passwd"))),
        // 範囲外を指すシンボリックリンクは開かない(7.2)
        format!("/api/tree?path={}", q(&r.join("link_out"))),
        format!("/api/media?path={}", q(&r.join("link_out/passwd"))),
    ];
    for path in outside {
        assert_eq!(a.get(&path).status(), 403, "{path}");
    }
}

// 基準5: `mp4v` の MP4 と AVI が変換されて再生でき、2回目はキャッシュから返る
#[test]
#[ignore = "S5 で実装"]
fn transcoded_segments_are_cached() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let work = tempfile::TempDir::new().unwrap();

    for name in ["mp4v.mp4", "xvid_mp3.avi"] {
        let query = format!(
            "/api/media?path={}&transcode=1&seg=0",
            q(&fixtures().join(name))
        );

        let first = a.get(&query);
        assert_eq!(first.status(), 200, "{name}");
        assert_eq!(first.headers()["x-dew-cache"], "miss", "{name}");
        let body = first.bytes().unwrap();

        let second = a.get(&query);
        assert_eq!(second.headers()["x-dew-cache"], "hit", "{name}");
        assert_eq!(second.bytes().unwrap(), body, "{name}");

        // 変換結果はブラウザでそのまま再生できる H.264 / AAC
        let seg = work.path().join(format!("{name}.seg0.mp4"));
        std::fs::write(&seg, &body).unwrap();
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
            ])
            .arg(&seg)
            .output()
            .unwrap();
        let codecs = String::from_utf8_lossy(&probe.stdout);
        assert!(
            codecs.contains("h264") && codecs.contains("aac"),
            "{name}: {codecs}"
        );
    }
}

// 基準8: 2つのコンテナで同時に起動しても、ポートとトークン(Cookie)が衝突しない
#[test]
#[ignore = "S3 で実装"]
fn two_instances_do_not_collide() {
    let port = free_port().to_string();
    let a = Instance::new();
    let b = Instance::new();
    // --network host のコンテナ同士を想定し、同じ待ち受けポートを指定する
    a.dew(&["--port", &port]);
    b.dew(&["--port", &port]);

    assert_ne!(a.port(), b.port(), "使用中なら次の空きポートを使う");
    assert_ne!(a.token(), b.token());
    let (name_a, _) = a.login();
    let (name_b, _) = b.login();
    assert!(name_a.starts_with("dew_") && name_b.starts_with("dew_"));
    assert_ne!(name_a, name_b, "Cookie 名にインスタンス ID を含める");

    // 他方のトークンでは開けない
    let res = client()
        .get(format!("{}/?token={}", b.base(), a.token()))
        .send()
        .unwrap();
    assert_eq!(res.status(), 401);
}
