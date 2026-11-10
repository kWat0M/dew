//! `dew config`: URL のホストとポートを git config の形で読み書きし、環境変数より弱い設定として URL に使う(ADR 0035)

mod common;

use std::path::Path;
use std::process::Output;

use common::{Instance, find_url, free_port};

fn dew(a: &Instance, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = a.command(env!("CARGO_BIN_EXE_dew"));
    cmd.current_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
        .args(args)
        .envs(env.iter().copied());
    cmd.output().unwrap()
}

fn ok(a: &Instance, args: &[&str], env: &[(&str, &str)]) -> Output {
    let out = dew(a, args, env);
    assert!(
        out.status.success(),
        "dew {args:?}\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn get_set_unset_list() {
    let a = Instance::new();
    let file = a.home.path().join(".config/dew/config.toml");

    // 未設定なら何も出さず、終了コード 1
    let out = dew(&a, &["config", "host"], &[]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stdout(&out), "");

    // コメントや表はそのまま残し、表より前に書く
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        "# 自分の設定\nopen_fallback_clipboard = true\n\n[csv]\nx = 1\n",
    )
    .unwrap();
    ok(&a, &["config", "host", "192.0.2.30"], &[]);
    ok(&a, &["config", "host", "192.0.2.31"], &[]);
    ok(&a, &["config", "port", "18765"], &[]);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "# 自分の設定\nopen_fallback_clipboard = true\nhost = \"192.0.2.31\"\nport = 18765\n\n[csv]\nx = 1\n"
    );
    assert_eq!(stdout(&ok(&a, &["config", "host"], &[])), "192.0.2.31\n");
    assert_eq!(stdout(&ok(&a, &["config", "port"], &[])), "18765\n");
    assert_eq!(
        stdout(&ok(&a, &["config", "--show-origin", "host"], &[])),
        format!("file:{}\t192.0.2.31\n", file.display())
    );

    // 環境変数が優先。設定すると、このシェルでは使われないことを知らせる
    let env = [("DEW_PUBLIC_HOST", "192.0.2.40")];
    assert_eq!(stdout(&ok(&a, &["config", "host"], &env)), "192.0.2.40\n");
    assert_eq!(
        stdout(&ok(&a, &["config", "--show-origin", "host"], &env)),
        "env:DEW_PUBLIC_HOST\t192.0.2.40\n"
    );
    let out = ok(&a, &["config", "host", "192.0.2.32"], &env);
    assert!(
        stderr(&out).contains("環境変数 DEW_PUBLIC_HOST"),
        "{}",
        stderr(&out)
    );
    // 空の環境変数は「未設定」で、設定ファイルも見ない
    let out = dew(&a, &["config", "host"], &[("DEW_PUBLIC_HOST", "")]);
    assert_eq!(out.status.code(), Some(1));

    // 一覧: 設定ファイル(名前の順)、続けて上書きしている環境変数(後のものが効く)
    assert_eq!(
        stdout(&ok(&a, &["config", "--list"], &env)),
        "csv.x=1\nhost=192.0.2.32\nopen_fallback_clipboard=true\nport=18765\nhost=192.0.2.40\n"
    );
    let out = ok(&a, &["config", "-l", "--show-origin"], &[]);
    assert!(
        stdout(&out).contains(&format!("file:{}\tport=18765\n", file.display())),
        "{}",
        stdout(&out)
    );

    // 書けない値は書かない
    for (key, v) in [
        ("port", "abc"),
        ("port", "0"),
        ("host", "https://192.0.2.1"),
        ("host", ""),
    ] {
        let out = dew(&a, &["config", key, v], &[]);
        assert!(!out.status.success(), "{key} {v}");
    }
    assert_eq!(stdout(&ok(&a, &["config", "port"], &[])), "18765\n");

    // 消す。設定がなければ終了コード 5
    ok(&a, &["config", "--unset", "host"], &[]);
    ok(&a, &["config", "--unset", "port"], &[]);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "# 自分の設定\nopen_fallback_clipboard = true\n\n[csv]\nx = 1\n"
    );
    assert_eq!(
        dew(&a, &["config", "--unset", "host"], &[]).status.code(),
        Some(5)
    );

    // 書き方が壊れているファイルは書き換えない
    std::fs::write(&file, "host = \n").unwrap();
    let out = dew(&a, &["config", "host", "192.0.2.33"], &[]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("dew config --edit"),
        "{}",
        stderr(&out)
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "host = \n");
}

#[test]
fn edit_opens_editor() {
    let a = Instance::new();
    // エディタの代わりに、渡されたファイルに1行足すコマンド
    let out = ok(
        &a,
        &["config", "--edit"],
        &[(
            "EDITOR",
            "sh -c 'echo \"host = \\\"192.0.2.50\\\"\" >> \"$1\"' editor",
        )],
    );
    assert_eq!(stderr(&out), "");
    assert_eq!(stdout(&ok(&a, &["config", "host"], &[])), "192.0.2.50\n");
}

#[test]
fn url_uses_config_unless_env_overrides() {
    let a = Instance::new();
    ok(&a, &["config", "host", "192.0.2.30"], &[]);

    // 空の環境変数で localhost にできる(ssh のポート転送の手順)
    let port = free_port().to_string();
    let out = ok(&a, &["--port", &port], &[("DEW_PUBLIC_HOST", "")]);
    let url = find_url(&out.stdout).expect("URL が表示される");
    assert!(url.starts_with("https://localhost:"), "{url}");
    assert!(
        stderr(&out).contains("URL のホスト: 未設定(DEW_PUBLIC_HOST が空なので localhost を使う)"),
        "{}",
        stderr(&out)
    );

    // この端末では設定ファイルの値になるので、起動し直すよう知らせる
    let out = ok(&a, &["url"], &[]);
    assert!(
        stderr(&out).contains("この端末では URL のホストが 192.0.2.30(dew config host)"),
        "{}",
        stderr(&out)
    );
    ok(&a, &["stop"], &[]);

    let out = ok(&a, &["--port", &port], &[]);
    let url = find_url(&out.stdout).expect("URL が表示される");
    assert!(url.starts_with("https://192.0.2.30:"), "{url}");
    assert!(
        stderr(&out).contains("URL のホスト: 192.0.2.30(dew config host)"),
        "{}",
        stderr(&out)
    );

    // 動いているサーバには効かないことを、設定したときに知らせる
    let out = ok(&a, &["config", "host", "192.0.2.31"], &[]);
    assert!(
        stderr(&out).contains("動いているサーバには効きません"),
        "{}",
        stderr(&out)
    );
}
