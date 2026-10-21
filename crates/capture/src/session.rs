//! ライブ描画のセッション: 専用の仮想ディスプレイ(Xvfb)と音声サーバ(pulseaudio)。
//! サーバに1つだけ作り、`dew run` と `dew env` のアプリはすべてここにつなぐ(6.1、7.9)

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use tokio::process::{Child, Command};

/// 仮想ディスプレイの大きさ(7.9)
pub const SCREEN: (u32, u32) = (3840, 2160);
/// 仮想ディスプレイ番号はここから空きを探す(9.1)
const FIRST_DISPLAY: u32 = 100;
const LAST_DISPLAY: u32 = 400;
/// 起動を待つ上限
const START_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Session {
    pub display: u32,
    /// 音声サーバ。pulseaudio がないときは None で、映像だけを映す(音は出ない)
    pub pulse: Option<Pulse>,
    xvfb: Child,
}

pub struct Pulse {
    /// pulseaudio のソケット(`PULSE_SERVER=unix:<ここ>`)
    pub socket: PathBuf,
    /// pulseaudio を操作するソケット(module-cli-protocol-unix。ウィンドウごとの音の振り分けに使う)
    pub cli: PathBuf,
    child: Child,
}

impl Drop for Session {
    /// SIGTERM で止める(SIGKILL だと Xvfb がロックファイルとソケットを残し、次から番号がずれていくため)
    fn drop(&mut self) {
        let pids: Vec<u32> = std::iter::once(&self.xvfb)
            .chain(self.pulse.as_ref().map(|p| &p.child))
            .filter_map(|c| c.id())
            .collect();
        for pid in &pids {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        // 終わるまで少し待つ(サーバが先に終わると、止まりきる前に次の dew が同じ番号を使おうとするため)
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2)
            && pids
                .iter()
                .any(|p| Path::new(&format!("/proc/{p}")).exists() && !zombie(*p))
        {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// 終わったが親に回収されていないプロセス(/proc には残る)
fn zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| {
        s.rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
    })
}

impl Session {
    /// 仮想ディスプレイと音声サーバを起動する。`dir` に音声サーバのソケットなどを置く。
    /// 仮想ディスプレイは `prefer`(前回の番号)が空いていればそれを使う。
    /// 音声サーバ(pulseaudio)がない・起動できないときは、映像だけのセッションにする
    pub async fn start(dir: &Path, prefer: Option<u32>) -> anyhow::Result<Self> {
        let (number, xvfb) = start_xvfb(prefer).await?;
        let pulse = match start_pulse(dir).await {
            Ok((socket, cli, child)) => Some(Pulse { socket, cli, child }),
            Err(e) => {
                tracing::warn!("音声サーバを起動できないので、音なしで映します: {e:#}");
                None
            }
        };
        tracing::info!(
            display = number,
            audio = pulse.is_some(),
            "ライブ描画のセッションを作りました"
        );
        Ok(Self {
            display: number,
            pulse,
            xvfb,
        })
    }

    /// アプリに渡す環境変数
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env = vec![("DISPLAY".into(), format!(":{}", self.display))];
        if let Some(p) = &self.pulse {
            env.push((
                "PULSE_SERVER".into(),
                format!("unix:{}", p.socket.display()),
            ));
        }
        env.extend([
            // Wayland ではなく仮想ディスプレイ(X11)に出させる
            ("GDK_BACKEND".into(), "x11".into()),
            ("QT_QPA_PLATFORM".into(), "xcb".into()),
            ("SDL_VIDEODRIVER".into(), "x11".into()),
        ]);
        env
    }

    /// 消す環境変数(ホストの Wayland や音声につながないように)
    pub const UNSET: &[&str] = &["WAYLAND_DISPLAY"];
}

/// `prefer` を試し、だめなら `:100` から順に空いている番号で Xvfb を起動する(複数ユーザー・複数コンテナで重ならないように。2.5)
async fn start_xvfb(prefer: Option<u32>) -> anyhow::Result<(u32, Child)> {
    let candidates = prefer
        .filter(|n| (FIRST_DISPLAY..=LAST_DISPLAY).contains(n))
        .into_iter()
        .chain(FIRST_DISPLAY..=LAST_DISPLAY);
    for n in candidates {
        if in_use(n) {
            continue;
        }
        let mut child = Command::new("Xvfb")
            .arg(format!(":{n}"))
            .args([
                "-screen",
                "0",
                &format!("{}x{}x24", SCREEN.0, SCREEN.1),
                "-nolisten",
                "tcp",
                "+extension",
                "XTEST",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Xvfb を起動できません(dew doctor で確認してください)")?;
        let start = Instant::now();
        while start.elapsed() < START_TIMEOUT {
            if child.try_wait()?.is_some() {
                break; // 他と同時に同じ番号を取ろうとして負けた。次の番号へ
            }
            // 同時に同じ番号を取り合ったとき、待ち受けているのが相手の Xvfb のことがあるので、
            // ロックファイルに書かれたプロセスが自分の起動したものかも確かめる
            let ours = std::fs::read_to_string(format!("/tmp/.X{n}-lock"))
                .ok()
                .and_then(|t| t.trim().parse::<u32>().ok())
                .is_some_and(|pid| Some(pid) == child.id());
            if ours && x_listening(n) {
                return Ok((n, child));
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let _ = child.kill().await;
    }
    bail!("仮想ディスプレイの番号 :{FIRST_DISPLAY}〜:{LAST_DISPLAY} がすべて使用中です")
}

/// 仮想ディスプレイ番号 `n` が使用中か。ロックファイルがあっても、書いたプロセスがもういなければ空きとみなす
/// (Xvfb は古いロックファイルを自分で片付けて起動する)
fn in_use(n: u32) -> bool {
    let Ok(text) = std::fs::read_to_string(format!("/tmp/.X{n}-lock")) else {
        return x_listening(n);
    };
    text.trim()
        .parse::<u32>()
        .is_ok_and(|pid| Path::new(&format!("/proc/{pid}")).exists())
}

/// 仮想ディスプレイ `n` が接続を受け付けているか。/tmp/.X11-unix のソケットに加えて、
/// Linux の抽象名前空間のソケットも見る(/tmp/.X11-unix の持ち主や権限が X の想定と違うと
/// ファイルのソケットは作られず、抽象名前空間だけで待ち受けるため。WSLg と共有している場合など)
fn x_listening(n: u32) -> bool {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixStream};
    let path = format!("/tmp/.X11-unix/X{n}");
    if UnixStream::connect(&path).is_ok() {
        return true;
    }
    SocketAddr::from_abstract_name(path.as_bytes())
        .is_ok_and(|addr| UnixStream::connect_addr(&addr).is_ok())
}

/// 専用の pulseaudio を起動する。出力先は音の出ない仮想のもの(null-sink)で、dew がその音を取り込む
async fn start_pulse(dir: &Path) -> anyhow::Result<(PathBuf, PathBuf, Child)> {
    let runtime = dir.join("pulse");
    tokio::fs::create_dir_all(&runtime).await?;
    let socket = runtime.join("native");
    let cli = runtime.join("cli");
    let _ = tokio::fs::remove_file(&socket).await;
    let _ = tokio::fs::remove_file(&cli).await;
    let child = Command::new("pulseaudio")
        // リアルタイム優先度を求めると D-Bus への接続を何度も試して起動が遅れるので、使わない
        .args([
            "--daemonize=no",
            "--exit-idle-time=-1",
            "--disable-shm=true",
            "-n",
            "--log-target=stderr",
        ])
        .args([
            "--realtime=false",
            "--high-priority=false",
            "--use-pid-file=false",
        ])
        .arg(format!(
            "--load=module-native-protocol-unix socket={} auth-anonymous=1",
            socket.display()
        ))
        .arg("--load=module-null-sink sink_name=dew sink_properties=device.description=dew")
        .arg("--load=module-always-sink")
        .arg(format!(
            "--load=module-cli-protocol-unix socket={}",
            cli.display()
        ))
        // ホストの音声サーバや設定を使わない
        .env("PULSE_RUNTIME_PATH", &runtime)
        .env("PULSE_STATE_PATH", &runtime)
        .env_remove("PULSE_SERVER")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("pulseaudio を起動できません(dew doctor で確認してください)")?;
    let start = Instant::now();
    while start.elapsed() < START_TIMEOUT {
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return Ok((socket, cli, child));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    bail!(
        "pulseaudio が {} 秒以内に起動しませんでした",
        START_TIMEOUT.as_secs()
    )
}
