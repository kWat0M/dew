//! dew の CLI と起動処理

mod client;
mod doctor;
mod hooks;
mod state;

use std::fs::File;
use std::io::Read;
use std::net::IpAddr;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};

use client::Api;
use state::ServerFile;

/// サーバの起動を待つ上限
const START_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Parser)]
#[command(
    name = "dew",
    version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("DEW_COMMIT"), ", ", env!("DEW_BUILD_DATE"), ")"),
    about = "コンテナ内の画像・動画を Windows のブラウザで見る",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Sub>,
    /// 開くファイルかディレクトリ
    path: Option<PathBuf>,
    #[command(flatten)]
    serve: ServeArgs,
}

#[derive(Subcommand)]
enum Sub {
    /// URL を再表示する
    Url,
    /// URL と状態を表示する
    Status,
    /// サーバを停止する
    Stop,
    /// 依存(ffmpeg、Xvfb、音声サーバ、GPU)を確認する
    Doctor,
    /// 仮想ディスプレイと音声を用意してコマンドを実行し、ウィンドウをブラウザに出す
    Run {
        /// 精度モード: cv2.imshow の画像を圧縮せずに送る(L3。プログラムは変えない)
        #[arg(long)]
        exact: bool,
        /// 実行するコマンドと引数
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },
    /// 仮想ディスプレイと音声につなぐ環境変数を出す(eval "$(dew env)" で、以降のコマンドをすべてライブ描画へ)
    Env,
}

#[derive(Args, Clone)]
struct ServeArgs {
    /// 待ち受けポート。使用中なら次の空きを使う
    #[arg(long, env = "DEW_PORT", default_value_t = 8765)]
    port: u16,
    /// 待ち受けアドレス(127.0.0.1 にすると ssh -L 専用)
    #[arg(long, default_value = "0.0.0.0")]
    bind: IpAddr,
    /// 閲覧できる範囲。既定は起動したディレクトリの git ルート、git 管理外なら $HOME(--root / でコンテナ全体)
    #[arg(long)]
    root: Option<PathBuf>,
    /// ffmpeg の同時実行数
    #[arg(long, default_value_t = 2)]
    jobs: usize,
    /// バックグラウンドに回らず、前面で動かす
    #[arg(long)]
    foreground: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    // dew run はアプリの終了コードをそのまま返す
    if let Some(Sub::Run { exact, command }) = &cli.command {
        return match run(&cli.serve, *exact, command) {
            Ok(code) => ExitCode::from(code),
            Err(e) => {
                eprintln!("dew: {e:#}");
                ExitCode::FAILURE
            }
        };
    }
    let result = match cli.command {
        Some(Sub::Url) => running().map(|s| print_url(&s)),
        Some(Sub::Status) => running().map(|s| {
            print_url(&s);
            println!("pid: {}  ポート: {}", s.pid, s.port);
        }),
        Some(Sub::Stop) => stop(),
        Some(Sub::Doctor) => {
            doctor::run();
            Ok(())
        }
        Some(Sub::Env) => env(&cli.serve),
        Some(Sub::Run { .. }) => unreachable!(),
        None if cli.serve.foreground => foreground(&cli.serve),
        None => start(&cli.serve, cli.path.as_deref()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("dew: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// サーバを用意し(起動済みなら再利用)、ファイルが指定されていればブラウザに送る
fn start(args: &ServeArgs, path: Option<&Path>) -> anyhow::Result<()> {
    let path = path
        .map(|p| {
            p.canonicalize()
                .with_context(|| format!("{} がありません", p.display()))
        })
        .transpose()?;
    let server = match alive() {
        Some(s) => {
            warn_if_stale(&s);
            s
        }
        None => {
            let missing = doctor::missing_required();
            if !missing.is_empty() {
                eprintln!(
                    "dew: 警告: {} がありません。動画の変換とサムネイルが使えません。導入: {}",
                    missing.join(", "),
                    doctor::install_command(&missing)
                );
            }
            let s = spawn(args)?;
            for w in &s.warnings {
                eprintln!("dew: 警告: {w}");
            }
            s
        }
    };
    if let Some(p) = path {
        let api = Api::new(&server);
        let res = match api.open(&p.to_string_lossy()) {
            Ok(r) => r,
            Err(client::OpenError::OutsideRoot) => bail!(
                "{} は閲覧範囲({})の外です。範囲を広げるには、dew stop の後、dew --root <ディレクトリ> で起動し直してください",
                p.display(),
                api.root().unwrap_or_default()
            ),
            Err(client::OpenError::Other(e)) => return Err(e),
        };
        if res.delivered {
            println!("ブラウザに表示しました: {}", p.display());
            return Ok(());
        }
        println!("接続中のブラウザがありません。次の URL を開いてください");
    }
    print_url(&server);
    Ok(())
}

/// 動いているサーバを返す。なければ起動する
fn ensure_server(args: &ServeArgs) -> anyhow::Result<ServerFile> {
    if let Some(s) = alive() {
        warn_if_stale(&s);
        return Ok(s);
    }
    let s = spawn(args)?;
    for w in &s.warnings {
        eprintln!("dew: 警告: {w}");
    }
    eprintln!("dew: サーバを起動しました。ブラウザで次の URL を開いてください");
    eprintln!("\x1b]8;;{0}\x1b\\{0}\x1b]8;;\x1b\\", s.url);
    Ok(s)
}

/// `dew run`: 仮想ディスプレイと音声につないでコマンドを実行し、終わるまで待つ(6.1)
fn run(args: &ServeArgs, exact: bool, command: &[String]) -> anyhow::Result<u8> {
    let server = ensure_server(args)?;
    let live = Api::new(&server).live_session()?;
    let mut cmd = Command::new(&command[0]);
    cmd.args(&command[1..])
        .envs(live.env.iter().map(|(k, v)| (k, v)));
    // 精度モード: 同梱のフックを PYTHONPATH の先頭に置き、cv2 を import したときに差し替えさせる(ADR 0017)
    if exact {
        let hooks = hooks::install()?;
        let path = match std::env::var_os("PYTHONPATH") {
            Some(old) if !old.is_empty() => {
                let mut p = hooks.into_os_string();
                p.push(":");
                p.push(old);
                p
            }
            _ => hooks.into_os_string(),
        };
        cmd.env("PYTHONPATH", path)
            .env("DEW_EXACT_SOCKET", &live.exact_socket);
    }
    for k in &live.unset {
        cmd.env_remove(k);
    }
    let status = cmd
        .status()
        .with_context(|| format!("{} を実行できません", command[0]))?;
    // シグナルで終わったときはシェルと同じく 128+番号
    use std::os::unix::process::ExitStatusExt;
    Ok(status
        .code()
        .map(|c| c as u8)
        .or_else(|| status.signal().map(|s| (128 + s) as u8))
        .unwrap_or(1))
}

/// `dew env`: シェルで eval できる形で、つなぐ設定を出す
fn env(args: &ServeArgs) -> anyhow::Result<()> {
    let server = ensure_server(args)?;
    let live = Api::new(&server).live_session()?;
    for (k, v) in &live.env {
        println!("export {k}={}", shell_quote(v));
    }
    for k in &live.unset {
        println!("unset {k}");
    }
    Ok(())
}

/// シェルで安全に使える形にする。記号の少ない値はそのまま、それ以外は単一引用符で囲む
fn shell_quote(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_:/.,=+-@".contains(c));
    if plain {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// 記録があり、実際に応答するサーバ
/// 動いているサーバが、今の dew より前のビルドなら知らせる。dew は動いているサーバを使い回すので、
/// ビルドし直しても `dew stop` するまでは古いサーバのまま(開発ビルドでは画面だけ新しくなり、食い違う)
fn warn_if_stale(s: &ServerFile) {
    if let (Some(server), Some(me)) = (s.exe_mtime, state::exe_mtime())
        && server != me
    {
        eprintln!(
            "dew: 警告: 動いているサーバは、この dew より前にビルドしたものです。新しい dew を使うには dew stop してから起動し直してください"
        );
    }
}

fn alive() -> Option<ServerFile> {
    let s = state::read()?;
    Api::new(&s).alive(&s.instance_id).then_some(s)
}

fn running() -> anyhow::Result<ServerFile> {
    alive().context("サーバは動いていません。dew で起動してください")
}

/// 自分自身を --foreground で起動し、端末から切り離す。待ち受けを始めるまで待つ
fn spawn(args: &ServeArgs) -> anyhow::Result<ServerFile> {
    let log_dir = state::cache_dir().join("log");
    std::fs::create_dir_all(&log_dir)?;
    let log_path = log_dir.join("server.log");
    let log = File::options().create(true).append(true).open(&log_path)?;
    let log_start = log.metadata()?.len();

    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("--foreground")
        .arg("--port")
        .arg(args.port.to_string())
        .arg("--bind")
        .arg(args.bind.to_string())
        .arg("--jobs")
        .arg(args.jobs.to_string());
    // 範囲の既定と Home の初期位置は、子プロセスが引き継いだ作業ディレクトリから決める
    if let Some(root) = &args.root {
        cmd.arg("--root").arg(root);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        // 端末のプロセスグループから外し、Ctrl+C や端末の終了で止まらないようにする
        .process_group(0)
        .spawn()
        .context("サーバを起動できません")?;

    let start = Instant::now();
    while start.elapsed() < START_TIMEOUT {
        if let Some(status) = child.try_wait()? {
            bail!(
                "サーバが起動直後に終了しました({status})\n{}",
                log_tail(&log_path, log_start)
            );
        }
        if let Some(s) = state::read().filter(|s| s.pid == child.id()) {
            return Ok(s);
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    bail!(
        "サーバが {} 秒以内に起動しませんでした\n{}",
        START_TIMEOUT.as_secs(),
        log_tail(&log_path, log_start)
    )
}

fn log_tail(path: &Path, from: u64) -> String {
    let mut s = String::new();
    if let Ok(mut f) = File::open(path) {
        let _ = f.read_to_string(&mut s);
    }
    s.get(from as usize..).unwrap_or("").to_owned()
}

/// 既定の閲覧範囲(7.2): `dir` を含む git リポジトリのルート。git 管理外なら $HOME。
/// git コマンドが入っていない環境もあるので、`.git` を親へたどって探す
fn default_root(dir: &Path) -> PathBuf {
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_owned());
    let found = dir.ancestors().find(|d| d.join(".git").exists());
    match found {
        Some(d) => d.to_owned(),
        None => {
            let home = state::home();
            home.canonicalize().unwrap_or(home)
        }
    }
}

/// 前面でサーバを動かす。待ち受けを始めたら server.json を書く
fn foreground(args: &ServeArgs) -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_ansi(false).init();
    let cwd = std::env::current_dir()?;
    let root = match &args.root {
        Some(r) => r
            .canonicalize()
            .with_context(|| format!("{} がありません", r.display()))?,
        None => default_root(&cwd),
    };
    let cfg = dew_server::Config {
        bind: args.bind,
        port: args.port,
        root,
        cache_dir: state::cache_dir(),
        jobs: args.jobs,
        home: cwd.canonicalize().unwrap_or(cwd),
        tls_dir: std::env::var_os("DEW_TLS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| state::home().join(".local/share/dew/tls")),
        public_host: std::env::var("DEW_PUBLIC_HOST")
            .ok()
            .filter(|s| !s.is_empty()),
        public_port: std::env::var("DEW_PUBLIC_PORT")
            .ok()
            .and_then(|s| s.parse().ok()),
    };
    let local_host = if args.bind.is_unspecified() {
        "127.0.0.1".to_owned()
    } else {
        args.bind.to_string()
    };
    let pid = std::process::id();
    let exe_mtime = state::exe_mtime();

    let rt = tokio::runtime::Runtime::new()?;
    let result = rt.block_on(dew_server::serve(cfg, |r| {
        let s = ServerFile {
            pid,
            port: r.port,
            token: r.token.clone(),
            instance_id: r.instance_id.clone(),
            local_host,
            url: r.url.clone(),
            warnings: r.warnings.clone(),
            exe_mtime,
        };
        if let Err(e) = state::write(&s) {
            tracing::error!("server.json を書けません: {e:#}");
        }
        print_url(&s);
    }));
    state::remove_if_owned(pid);
    result
}

fn stop() -> anyhow::Result<()> {
    let Some(s) = state::read() else {
        println!("サーバは動いていません");
        return Ok(());
    };
    let api = Api::new(&s);
    if api.alive(&s.instance_id) {
        api.shutdown()?;
    }
    // 終了して server.json を消すまで待つ
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if !Path::new(&format!("/proc/{}", s.pid)).exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    state::remove_if_owned(s.pid);
    println!("停止しました");
    Ok(())
}

/// URL を OSC 8 ハイパーリンクで表示する(WezTerm ではクリックで開ける)
fn print_url(s: &ServerFile) {
    println!("\x1b]8;;{0}\x1b\\{0}\x1b]8;;\x1b\\", s.url);
}
