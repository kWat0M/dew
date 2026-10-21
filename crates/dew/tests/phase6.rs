//! フェーズ6の受け入れ基準(docs/spec.md 11章)のうち、サーバで確かめるもの: 文書を UTF-8 にして返す `/api/text`(15.8)。
//! 描画とキー操作は tests/e2e/specs/phase6.spec.ts

mod common;

use common::{Instance, copy_fixtures, free_port, q};
use serde_json::Value;

fn start() -> (Instance, tempfile::TempDir, std::path::PathBuf) {
    let root = copy_fixtures();
    let dir = root.path().canonicalize().unwrap();
    let a = Instance::new();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        dir.to_str().unwrap(),
    ]);
    (a, root, dir)
}

fn text(a: &Instance, path: &std::path::Path, extra: &str) -> Value {
    let res = a.get(&format!("/api/text?path={}{extra}", q(path)));
    assert_eq!(res.status(), 200);
    serde_json::from_str(&res.text().unwrap()).unwrap()
}

#[test]
fn utf8_markdown_is_returned_as_is() {
    let (a, _root, dir) = start();
    let t = text(&a, &dir.join("md/all.md"), "");
    assert_eq!(t["encoding"], "utf8");
    assert_eq!(t["detected"], "utf8");
    assert!(t["text"].as_str().unwrap().starts_with("---\ntitle:"));
    assert_eq!(t["large"], false);
}

// 基準7(サーバ側): Shift_JIS を判定して UTF-8 にする。手で文字コードを指定もできる
#[test]
fn shift_jis_is_detected_and_converted() {
    let (a, _root, dir) = start();
    let p = dir.join("md/sjis.md");
    let t = text(&a, &p, "");
    assert_eq!(t["encoding"], "shiftJis", "{t}");
    let body = t["text"].as_str().unwrap();
    assert!(body.contains("# 日本語の見出し"), "{body}");
    assert!(body.contains("（全角括弧）"), "{body}");
    // UTF-8 として読ませると化ける(置き換え文字になる)。判定結果は変わらない
    let t = text(&a, &p, "&encoding=utf8");
    assert_eq!(t["encoding"], "utf8");
    assert_eq!(t["detected"], "shiftJis");
    assert!(t["text"].as_str().unwrap().contains('\u{fffd}'));
}

#[test]
fn bom_decides_the_encoding() {
    let (a, _root, dir) = start();
    let p = dir.join("utf16.md");
    let mut bytes = vec![0xff, 0xfe];
    for u in "# UTF-16 の文書".encode_utf16() {
        bytes.extend(u.to_le_bytes());
    }
    std::fs::write(&p, bytes).unwrap();
    let t = text(&a, &p, "");
    assert_eq!(t["encoding"], "utf16le");
    assert_eq!(t["text"], "# UTF-16 の文書");

    // UTF-8 の BOM は取り除く
    std::fs::write(&p, b"\xef\xbb\xbf# BOM").unwrap();
    let t = text(&a, &p, "");
    assert_eq!(t["encoding"], "utf8");
    assert_eq!(t["text"], "# BOM");
}

#[test]
fn euc_jp_is_detected() {
    let (a, _root, dir) = start();
    let p = dir.join("euc.md");
    std::fs::write(
        &p,
        euc_jp("# 日本語の見出し\n\nこれは EUC-JP で書いた長めの文書です。漢字とかなを含みます。"),
    )
    .unwrap();
    let t = text(&a, &p, "");
    assert_eq!(t["encoding"], "eucJp", "{t}");
    assert!(t["text"].as_str().unwrap().contains("日本語の見出し"));
}

/// python で EUC-JP にする(テストのために依存を増やさないため)
fn euc_jp(s: &str) -> Vec<u8> {
    let out = std::process::Command::new("python3")
        .args([
            "-c",
            "import sys; sys.stdout.buffer.write(sys.argv[1].encode('euc_jp'))",
            s,
        ])
        .output()
        .unwrap();
    out.stdout
}

// 17.5: 5 MB を超える Markdown は、描画せずにプレーンテキストとして出す(サーバは印を付ける)
#[test]
fn large_text_is_marked() {
    let (a, _root, dir) = start();
    let p = dir.join("big.md");
    std::fs::write(&p, "a".repeat(5 * 1024 * 1024 + 1)).unwrap();
    let t = text(&a, &p, "");
    assert_eq!(t["large"], true);
}

#[test]
fn text_outside_root_is_403_and_kind_is_markdown() {
    let (a, _root, dir) = start();
    assert_eq!(a.get("/api/text?path=%2Fetc%2Fpasswd").status(), 403);
    let tree: Value =
        serde_json::from_str(&a.get(&format!("/api/tree?path={}", q(&dir.join("md")))).text().unwrap())
            .unwrap();
    let all = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "all.md")
        .unwrap();
    assert_eq!(all["media"], "markdown");
}
