//! dew の CLI と起動処理

mod client;
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
    version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("DEW_BUILD_DATE"), ")"),
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
}

#[derive(Args, Clone)]
struct ServeArgs {
    /// 待ち受けポート。使用中なら次の空きを使う
    #[arg(long, env = "DEW_PORT", default_value_t = 8765)]
    port: u16,
    /// 待ち受けアドレス(127.0.0.1 にすると ssh -L 専用)
    #[arg(long, default_value = "0.0.0.0")]
    bind: IpAddr,
    /// 閲覧できる範囲
    #[arg(long, default_value = "/")]
    root: PathBuf,
    /// バックグラウンドに回らず、前面で動かす
    #[arg(long)]
    foreground: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Some(Sub::Url) => running().map(|s| print_url(&s)),
        Some(Sub::Status) => running().map(|s| {
            print_url(&s);
            println!("pid: {}  ポート: {}", s.pid, s.port);
        }),
        Some(Sub::Stop) => stop(),
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
        Some(s) => s,
        None => {
            let s = spawn(args)?;
            for w in &s.warnings {
                eprintln!("dew: 警告: {w}");
            }
            s
        }
    };
    if let Some(p) = path {
        let res = Api::new(&server).open(&p.to_string_lossy())?;
        if res.delivered {
            println!("ブラウザに表示しました: {}", p.display());
            return Ok(());
        }
        println!("接続中のブラウザがありません。次の URL を開いてください");
    }
    print_url(&server);
    Ok(())
}

/// 記録があり、実際に応答するサーバ
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

    let mut child = Command::new(std::env::current_exe()?)
        .arg("--foreground")
        .arg("--port")
        .arg(args.port.to_string())
        .arg("--bind")
        .arg(args.bind.to_string())
        .arg("--root")
        .arg(&args.root)
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

/// 前面でサーバを動かす。待ち受けを始めたら server.json を書く
fn foreground(args: &ServeArgs) -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_ansi(false).init();
    let root = args
        .root
        .canonicalize()
        .with_context(|| format!("{} がありません", args.root.display()))?;
    let cfg = dew_server::Config {
        bind: args.bind,
        port: args.port,
        root,
        home: state::home()
            .canonicalize()
            .unwrap_or_else(|_| state::home()),
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
