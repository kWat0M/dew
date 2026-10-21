//! フェーズ5の受け入れ基準(docs/spec.md 11章)のうち、CLI とサーバで確かめられるもの。
//! タブの自動再接続、Home を開いたときの予約の表示、裏のタブの `●` は tests/e2e/specs/phase5.spec.ts にある

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

use common::{Instance, Ws, fixtures, free_port, wait_until};
use serde_json::Value;
use tungstenite::Message;

/// `shell`(bash / zsh)でスクリプトを動かす。シェル連携は rc ファイルではなくスクリプトの先頭で読み込む
fn shell(a: &Instance, shell: &str, port: u16, script: &str) -> Command {
    let mut cmd = a.command(which(shell));
    cmd.arg("-c")
        .arg(format!("eval \"$(dew shell-init {shell})\"\n{script}"))
        .env("DEW_PORT", port.to_string())
        .env("SHELL", which(shell))
        .current_dir(a.home.path());
    cmd
}

fn which(cmd: &str) -> String {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|d| d.join(cmd))
        .find(|p| p.exists())
        .unwrap_or_else(|| panic!("{cmd} がありません(開発用コンテナの Dockerfile で入れる)"))
        .to_string_lossy()
        .into_owned()
}

fn text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr)
}

fn run_ok(mut cmd: Command) -> String {
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "{}", text(&out));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// `KEY=値` の行を読む(値がなければ None)
fn var(out: &str, section: &str, key: &str) -> Option<String> {
    let body = out.split(&format!("--{section}--\n")).nth(1).unwrap();
    let body = body.split("--").next().unwrap();
    body.lines()
        .find_map(|l| l.strip_prefix(&format!("{key}=")))
        .map(str::to_owned)
        .filter(|v| v != "<unset>")
}

/// 変数の今の値を `KEY=値` で書き出すシェルの断片(未設定は <unset>)
fn dump(section: &str) -> String {
    let mut s = format!("echo --{section}--\n");
    for k in [
        "DISPLAY",
        "PULSE_SERVER",
        "WAYLAND_DISPLAY",
        "QT_QPA_PLATFORM",
        "GDK_BACKEND",
        "SDL_VIDEODRIVER",
        "DEW_ACTIVE",
    ] {
        s.push_str(&format!("echo \"{k}=${{{k}-<unset>}}\"\n"));
    }
    s.push_str("echo \"SAVED=$(env | grep -c '^_DEW_SAVED_')\"\n");
    s
}

// 基準1: `dew setup-shell` を2回実行しても、rc ファイルへの追記は1行だけ
#[test]
fn setup_shell_appends_once() {
    for (sh, rc) in [("bash", ".bashrc"), ("zsh", ".zshrc")] {
        let a = Instance::new();
        std::fs::write(a.home.path().join(rc), "# 既存の設定\n").unwrap();
        for _ in 0..2 {
            let mut child = a
                .command(env!("CARGO_BIN_EXE_dew"))
                .arg("setup-shell")
                .env("SHELL", format!("/usr/bin/{sh}"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(b"y\n").unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{}", text(&out));
        }
        let body = std::fs::read_to_string(a.home.path().join(rc)).unwrap();
        let line = format!("eval \"$(dew shell-init {sh})\"");
        assert_eq!(body.matches(&line).count(), 1, "{body}");
        assert!(body.starts_with("# 既存の設定\n"), "既存の中身は残す\n{body}");
    }
}

// 基準2: bash と zsh で `dew activate` したあと、`dew run` なしのアプリのウィンドウがキャンバスに出る
// (キャンバスはサーバが送るライブウィンドウの一覧をそのまま映す。映る側は tests/e2e の phase3 で確かめている)
#[test]
fn activated_shell_app_appears_bash() {
    activated_shell_app_appears("bash");
}

#[test]
fn activated_shell_app_appears_zsh() {
    activated_shell_app_appears("zsh");
}

fn activated_shell_app_appears(sh: &str) {
    let a = Instance::new();
    let port = free_port();
    let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/apps/counter.py");
    let script = format!(
        "dew activate\npython3 {} --title counter-{sh} --tone 0 --seconds 20",
        app.display()
    );
    let mut child = shell(&a, sh, port, &script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // activate がサーバを起動するまで待つ
    assert!(
        wait_until(Duration::from_secs(20), || a
            .home
            .path()
            .join(".cache/dew/server.json")
            .exists()),
        "サーバが起動しない"
    );
    let mut ws = a.ws("/ws/events");
    let title = format!("counter-{sh}");
    let found = recv_live_title(&mut ws, &title, Duration::from_secs(20));
    let _ = child.kill();
    let out = child.wait_with_output().unwrap();
    assert!(found, "{title} のウィンドウが出ない\n{}", text(&out));
}

/// ライブウィンドウの一覧に `title` が出るまで待つ
fn recv_live_title(ws: &mut Ws, title: &str, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        let Ok(Message::Text(t)) = ws.read() else {
            continue;
        };
        let v: Value = serde_json::from_str(&t).unwrap();
        if v["type"] == "liveWindows"
            && v["windows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w["title"] == title)
        {
            return true;
        }
    }
    false
}

// 基準3・4: activate 中は WAYLAND_DISPLAY が未設定。deactivate で元に戻る(未設定だったものは未設定)。
// activate を2回実行しても、deactivate 1回で戻る
#[test]
fn deactivate_restores_env_bash() {
    deactivate_restores_env("bash");
}

#[test]
fn deactivate_restores_env_zsh() {
    deactivate_restores_env("zsh");
}

fn deactivate_restores_env(sh: &str) {
    let a = Instance::new();
    let script = format!(
        "export DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 QT_QPA_PLATFORM=wayland\n\
         unset PULSE_SERVER GDK_BACKEND SDL_VIDEODRIVER\n\
         {}dew activate\n{}dew activate\n{}dew deactivate\n{}dew deactivate\n{}",
        dump("before"),
        dump("active"),
        dump("twice"),
        dump("after"),
        dump("again"),
    );
    let out = run_ok(shell(&a, sh, free_port(), &script));

    assert!(var(&out, "active", "DISPLAY").unwrap().starts_with(':'));
    assert_ne!(var(&out, "active", "DISPLAY").as_deref(), Some(":0"));
    assert!(
        var(&out, "active", "PULSE_SERVER")
            .unwrap()
            .starts_with("unix:")
    );
    assert_eq!(var(&out, "active", "WAYLAND_DISPLAY"), None, "{out}");
    assert_eq!(var(&out, "active", "QT_QPA_PLATFORM").as_deref(), Some("xcb"));
    assert_eq!(var(&out, "active", "GDK_BACKEND").as_deref(), Some("x11"));
    assert_eq!(var(&out, "active", "SDL_VIDEODRIVER").as_deref(), Some("x11"));
    assert_eq!(var(&out, "active", "DEW_ACTIVE").as_deref(), Some("1"));
    // 2回目は何もしない(保存した元の値を上書きしない)
    for k in ["DISPLAY", "PULSE_SERVER", "WAYLAND_DISPLAY", "SAVED"] {
        assert_eq!(var(&out, "active", k), var(&out, "twice", k), "{k}\n{out}");
    }
    for k in [
        "DISPLAY",
        "PULSE_SERVER",
        "WAYLAND_DISPLAY",
        "QT_QPA_PLATFORM",
        "GDK_BACKEND",
        "SDL_VIDEODRIVER",
        "DEW_ACTIVE",
    ] {
        assert_eq!(var(&out, "before", k), var(&out, "after", k), "{k}\n{out}");
        assert_eq!(var(&out, "before", k), var(&out, "again", k), "{k}\n{out}");
    }
    assert_eq!(var(&out, "after", "SAVED").as_deref(), Some("0"), "{out}");
}

// 基準5: シェル連携なしで `dew activate` を実行すると、導入方法を表示して終了コード 1
#[test]
fn activate_without_shell_integration_explains_setup() {
    let a = Instance::new();
    let out = a.try_dew_in(a.home.path(), &["activate"]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));
    assert!(text(&out).contains("dew setup-shell"), "{}", text(&out));
    // サーバは起動しない
    assert!(!a.home.path().join(".cache/dew/server.json").exists());
}

/// `dew status` が出す、activate 中のシェルの数
fn shells(a: &Instance) -> usize {
    let out = a.dew(&["status"]);
    let s = String::from_utf8_lossy(&out.stdout).into_owned();
    s.lines()
        .find_map(|l| l.strip_prefix("activate 中のシェル: "))
        .unwrap_or_else(|| panic!("{s}"))
        .trim()
        .parse()
        .unwrap()
}

/// activate して、終了の合図まで待ち続けるシェル
fn activated_shell(a: &Instance, port: u16) -> Child {
    let child = shell(a, "bash", port, "dew activate\nexec 3<&0\nread -r _ <&3")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(
        wait_until(Duration::from_secs(20), || a
            .home
            .path()
            .join(".cache/dew/server.json")
            .exists()
            && shells(a) == 1),
        "シェルが登録されない"
    );
    child
}

// 基準6: activate 中のシェルがある間は自動停止しない(判定はサーバの単体テスト)。
// そのシェルを終了すると、1分以内に登録が消える。端末を閉じた場合(SIGKILL)も同じ
#[test]
fn closed_shell_is_unregistered_within_a_minute() {
    let a = Instance::new();
    let mut child = activated_shell(&a, free_port());
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        wait_until(Duration::from_secs(60), || shells(&a) == 0),
        "1分たっても登録が消えない"
    );
}

#[test]
fn deactivate_unregisters_and_stop_asks_while_active() {
    let a = Instance::new();
    let port = free_port();
    let mut child = activated_shell(&a, port);
    // activate 中のシェルがあると、dew stop は確認する(答えなければ止めない)
    let out = a.try_dew_in(a.home.path(), &["stop"]);
    assert!(text(&out).contains("activate 中のシェルが 1 個"), "{}", text(&out));
    assert_eq!(shells(&a), 1, "止まっていない");
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
    child.wait().unwrap();

    // deactivate したら、すぐに登録が消える(終わったばかりの上のシェルは、点検まで残っていることがある)
    let out = run_ok(shell(
        &a,
        "bash",
        port,
        "dew activate\ndew status\ndew deactivate\ndew status",
    ));
    let counts: Vec<usize> = out
        .lines()
        .filter_map(|l| l.strip_prefix("activate 中のシェル: "))
        .map(|n| n.trim().parse().unwrap())
        .collect();
    assert_eq!(counts.len(), 2, "{out}");
    assert_eq!(counts[1] + 1, counts[0], "{out}");
}

// 基準7: サーバを再起動しても、仮想ディスプレイ番号とトークン、(--port の指定がなければ)ポートが変わらない。
// タブの再接続は tests/e2e/specs/phase5.spec.ts
#[test]
fn restart_keeps_display_token_and_port() {
    let a = Instance::new();
    let port = free_port();
    a.dew(&["--port", &port.to_string()]);
    let display = |a: &Instance| {
        String::from_utf8_lossy(&a.dew(&["env"]).stdout)
            .lines()
            .find_map(|l| l.strip_prefix("export DISPLAY="))
            .unwrap()
            .to_owned()
    };
    let d1 = display(&a);
    let t1 = a.token();
    a.dew(&["stop"]);
    // --port も DEW_PORT も付けない(前回のポートを使い直す)
    a.dew(&[]);
    assert_eq!(a.port(), port, "前回のポートを使い直す");
    assert_eq!(a.token(), t1, "トークンは保存して再利用する");
    assert_eq!(display(&a), d1, "仮想ディスプレイの番号を再利用する");
    let token_file = a.home.path().join(".local/share/dew/token");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&token_file).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // dew rotate-token で作り直す(動いているサーバにもすぐ効く)
    a.dew(&["rotate-token"]);
    let t2 = a.token();
    assert_ne!(t2, t1);
    let res = common::client()
        .get(format!("{}/?token={t1}", a.base()))
        .send()
        .unwrap();
    assert_eq!(res.status(), 401, "古いトークンは使えない");
    assert_eq!(a.get("/api/health").status(), 200);
}

/// 疑似端末の上で dew を動かし、端末に書かれたものをすべて返す(/dev/tty への書き込みも含む)
fn in_pty(a: &Instance, args: &[&str], env: &[(&str, &str)]) -> String {
    let py = r#"
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out = b""
while True:
    try:
        b = os.read(fd, 4096)
    except OSError:
        break
    if not b:
        break
    out += b
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
"#;
    let mut cmd = a.command("python3");
    cmd.arg("-c")
        .arg(py)
        .arg(env!("CARGO_BIN_EXE_dew"))
        .args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn base64_decode(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
        acc = (acc << 6) | T.iter().position(|&t| t == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// `ESC ] 1337 ; SetUserVar=dew_open=<base64> BEL` の URL
fn user_var_url(out: &str) -> String {
    let start = out
        .find("\x1b]1337;SetUserVar=dew_open=")
        .unwrap_or_else(|| panic!("ユーザー変数がない: {out:?}"))
        + "\x1b]1337;SetUserVar=dew_open=".len();
    let end = start + out[start..].find('\x07').unwrap();
    String::from_utf8(base64_decode(&out[start..end])).unwrap()
}

// 基準8: タブがないときの `dew a.mp4` は、疑似端末にユーザー変数と OSC 777 の通知を書き、
// base64 を復号した URL に a.mp4 のパスが入る。$TMUX があれば passthrough で包む
#[test]
fn no_tab_writes_user_var_and_notify_to_tty() {
    let a = Instance::new();
    let root = common::copy_fixtures();
    let root_path = root.path().canonicalize().unwrap();
    a.dew(&[
        "--port",
        &free_port().to_string(),
        "--root",
        root_path.to_str().unwrap(),
    ]);
    let file = root_path.join("h264_aac.mp4");

    let out = in_pty(&a, &[file.to_str().unwrap()], &[]);
    let url = user_var_url(&out);
    assert!(url.contains("/open?path="), "{url}");
    assert!(url.contains(file.to_str().unwrap()), "{url}");
    assert!(url.contains(&format!("token={}", a.token())), "{url}");
    assert!(
        out.contains("\x1b]777;notify;dew;ブラウザで開きます\x07"),
        "{out:?}"
    );
    assert!(out.contains("ブラウザのタブがありません"), "{out:?}");

    // tmux の中: passthrough で包み、中の ESC は2つにする
    let out = in_pty(
        &a,
        &[file.to_str().unwrap()],
        &[("TMUX", "/tmp/tmux-1000/default,1,0")],
    );
    assert!(
        out.contains("\x1bPtmux;\x1b\x1b]1337;SetUserVar=dew_open="),
        "{out:?}"
    );
    assert!(out.contains("\x1bPtmux;\x1b\x1b]777;notify;"), "{out:?}");
    assert!(out.contains("\x07\x1b\\"), "{out:?}");

    // 書いた URL を開くと、トークンを Cookie に移したあと、そのファイルを開く Home へ移る
    let res = common::client().get(&url).send().unwrap();
    assert!(res.status().is_redirection(), "{}", res.status());
    let cookie = res.headers()["set-cookie"].to_str().unwrap().to_owned();
    let cookie = cookie.split(';').next().unwrap();
    let next = res.headers()["location"].to_str().unwrap().to_owned();
    assert!(next.starts_with("/open?path="), "{next}");
    let res = common::client()
        .get(format!("{}{next}", a.base()))
        .header("cookie", cookie)
        .send()
        .unwrap();
    assert!(res.status().is_redirection(), "{}", res.status());
    assert_eq!(res.headers()["location"], "/");
}

// 制御端末がなければ書き込まない(yazi の orphan = true など)。標準エラー出力の URL だけ出す
#[test]
fn no_tty_prints_url_only() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let file = fixtures().join("h264_aac.mp4");
    let out = a
        .command("setsid")
        .arg(env!("CARGO_BIN_EXE_dew"))
        .arg(&file)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("ブラウザのタブがありません"), "{err}");
    assert!(err.contains("/open?path="), "{err}");
}

// 基準9(サーバ側): タブがないときの表示指示は予約され、2分以内につないだタブに届く。予約は最新の1件
#[test]
fn reservation_is_delivered_to_next_tab() {
    let a = Instance::new();
    a.dew(&["--port", &free_port().to_string()]);
    let first = fixtures().join("image.png");
    let file = fixtures().join("h264_aac.mp4");
    let out = a.dew(&[first.to_str().unwrap()]);
    assert!(out.status.success());
    a.dew(&[file.to_str().unwrap()]);

    let mut ws = a.ws("/ws/events");
    let ev = loop {
        let Message::Text(t) = ws.read().expect("予約が届かない") else {
            continue;
        };
        let v: Value = serde_json::from_str(&t).unwrap();
        if v["type"] == "open" {
            break v;
        }
    };
    assert_eq!(ev["path"], file.to_str().unwrap(), "最新の1件だけ");
    // 届けたら消える(次のタブには届かない)
    let mut second = a.ws("/ws/events");
    second
        .get_mut()
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(800)))
        .unwrap();
    while let Ok(m) = second.read() {
        if let Message::Text(t) = m {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_ne!(v["type"], "open", "{v}");
        }
    }
}
