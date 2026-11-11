//! URL と一緒に、URL を決めた設定(DEW_PUBLIC_HOST / DEW_PUBLIC_PORT か dew config)を出す(ADR 0033、0035)

mod common;

use std::path::Path;
use std::process::Output;

use common::{Instance, find_url, free_port};

fn dew(a: &Instance, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = a.command(env!("CARGO_BIN_EXE_dew"));
    cmd.current_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
        .args(args)
        .envs(env.iter().copied());
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

#[test]
fn url_shows_public_settings_and_stale_env() {
    let a = Instance::new();
    let port = free_port().to_string();
    let out = dew(&a, &["--port", &port], &[("DEW_PUBLIC_HOST", "192.0.2.10")]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains(&format!(
            "dew: URL の host: 192.0.2.10(DEW_PUBLIC_HOST)・port: {}(default)\n",
            a.port()
        )),
        "{err}"
    );
    // 標準出力は URL だけ
    let url = find_url(&out.stdout).expect("URL が表示される");
    assert!(url.starts_with("https://192.0.2.10:"), "{url}");

    // 同じ値なら注意は出さない
    let out = dew(&a, &["url"], &[("DEW_PUBLIC_HOST", "192.0.2.10")]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!err.contains("注意"), "{err}");

    // この端末で値を変えても、動いているサーバには効かないことを知らせる
    let out = dew(&a, &["url"], &[("DEW_PUBLIC_HOST", "192.0.2.20")]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("URL の host: 192.0.2.10(DEW_PUBLIC_HOST)"),
        "{err}"
    );
    assert!(
        err.contains("この端末では URL の host が 192.0.2.20(DEW_PUBLIC_HOST)"),
        "{err}"
    );
}
