//! dew の CLI と起動処理

mod client;
mod config;
mod doctor;
mod hooks;
mod shell;
mod state;
mod term;
mod update;

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
    Url {
        /// 端末からブラウザに Home を開かせる(WezTerm。dew setup-wezterm の設定が要る)
        #[arg(long)]
        open: bool,
        /// URL を端末のクリップボードにコピーする(OSC 52)
        #[arg(long)]
        copy: bool,
    },
    /// URL と状態を表示する
    Status,
    /// サーバを停止する
    Stop {
        /// activate 中のシェルがあっても確認せずに止める
        #[arg(long)]
        force: bool,
    },
    /// 依存(ffmpeg、Xvfb、音声サーバ、GPU)と、端末との連携を確認する
    #[command(long_about = doctor::HELP)]
    Doctor,
    /// 新しい版を取得して、この dew を置き換える(GitHub の Releases から)
    Update,
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
    /// このシェルのアプリを dew に映す(dew deactivate で戻す)。シェル連携(dew setup-shell)が要る
    Activate {
        /// 精度モード: cv2.imshow の画像を圧縮せずに送る(L3)
        #[arg(long)]
        exact: bool,
        #[command(flatten)]
        shell: ShellArgs,
    },
    /// dew activate で変えた環境変数を元に戻す
    Deactivate {
        #[command(flatten)]
        shell: ShellArgs,
    },
    /// シェル関数のコードを出す(rc ファイルに eval "$(dew shell-init bash)" と書く)
    #[command(long_about = shell::INIT_HELP)]
    ShellInit {
        #[arg(value_enum)]
        shell: shell::Shell,
    },
    /// ~/.bashrc か ~/.zshrc に、シェル連携の1行を足す(確認してから)
    SetupShell,
    /// 端末(WezTerm)から Windows のブラウザを開くための設定を表示する(書き込みはしない)
    SetupWezterm,
    /// トークンを作り直す(接続中のタブは切れる)
    RotateToken,
}

/// シェル関数が付ける引数(13.2)
#[derive(Args, Clone)]
struct ShellArgs {
    /// シェルが eval するコードを出す
    #[arg(long, hide = true)]
    emit_shell: bool,
    /// シェル本体の PID(サーバに登録する)
    #[arg(long, hide = true)]
    shell_pid: Option<u32>,
}

#[derive(Args, Clone)]
struct ServeArgs {
    /// 待ち受けポート。使用中なら次の空きを使う。指定がなければ前回のポート、だめなら 8765 から
    #[arg(long, env = "DEW_PORT")]
    port: Option<u16>,
    /// 待ち受けアドレス(127.0.0.1 にすると ssh -L 専用)
    #[arg(long, default_value = "0.0.0.0")]
    bind: IpAddr,
    /// 閲覧できる範囲。既定は起動したディレクトリの git ルート、git 管理外なら $HOME、$HOME の外なら起動したディレクトリ(--root / でコンテナ全体)
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
        Some(Sub::Url { open, copy }) => url(open, copy),
        Some(Sub::Status) => running().map(|s| {
            print_url(&s);
            if let Some(line) = root_line(&s) {
                println!("{line}");
            }
            println!("pid: {}  ポート: {}", s.pid, s.port);
            if let Ok(n) = Api::new(&s).shells() {
                println!("activate 中のシェル: {n}");
            }
        }),
        Some(Sub::Stop { force }) => stop(force),
        Some(Sub::Doctor) => {
            doctor::run();
            Ok(())
        }
        Some(Sub::Env) => env(&cli.serve),
        Some(Sub::Activate { exact, shell }) => activate(&cli.serve, exact, &shell),
        Some(Sub::Deactivate { shell }) => deactivate(&shell),
        Some(Sub::ShellInit { shell }) => {
            shell::init(shell);
            Ok(())
        }
        Some(Sub::SetupShell) => shell::setup(),
        Some(Sub::SetupWezterm) => {
            print!("{}", term::WEZTERM_SETUP);
            Ok(())
        }
        Some(Sub::RotateToken) => rotate_token(),
        Some(Sub::Update) => update::run(),
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
            // ツールが足りなくても起動する(閲覧と、ブラウザで再生できる形式の再生はツールなしで使える。ADR 0019)
            let unavailable = doctor::unavailable();
            if !unavailable.is_empty() {
                let mut pkgs: Vec<&str> = Vec::new();
                for (name, ps) in &unavailable {
                    eprintln!("dew: 注意: 使えない機能: {name}");
                    for p in ps {
                        if !pkgs.contains(p) {
                            pkgs.push(p);
                        }
                    }
                }
                eprintln!(
                    "dew: ファイルの閲覧と再生はできます。全部使うには: {}(dew doctor で詳しく)",
                    doctor::install_command(&pkgs)
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
        let path_text = p.to_string_lossy();
        let res = match api.open(&path_text) {
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
        // タブがない(14.5): サーバが2分間予約している。端末からブラウザを開かせ、URL も出す
        let url = open_url(&server, Some(&path_text));
        term::open_in_browser(&url);
        if config::load().open_fallback_clipboard {
            term::copy(&url);
        }
        eprintln!("dew: ブラウザのタブがありません: {}", term::link(&url));
        return Ok(());
    }
    if let Some(line) = root_line(&server) {
        eprintln!("dew: {line}");
    }
    print_url(&server);
    Ok(())
}

/// 閲覧範囲と変え方(範囲が思ったのと違うときに気づけるように)。前の版のサーバは記録がないので出さない
fn root_line(s: &ServerFile) -> Option<String> {
    (!s.root.is_empty()).then(|| {
        format!(
            "閲覧範囲: {}(変えるには dew stop の後、dew --root <ディレクトリ> で起動し直す)",
            s.root
        )
    })
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
    check_live_deps()?;
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

/// ライブ描画に要るもの(ffmpeg、Xvfb、pulseaudio)がそろっているか。足りなければ入れ方を出して止める
fn check_live_deps() -> anyhow::Result<()> {
    let missing = doctor::missing_live();
    if !missing.is_empty() {
        bail!(
            "ライブ描画(dew run / dew env)に要る {} がありません。次のコマンドで入れてください:\n  {}",
            missing.join("・"),
            doctor::install_command(&missing)
        );
    }
    if !doctor::has_audio() {
        eprintln!(
            "dew: 注意: pulseaudio がないので、アプリの音は出ません(映像は映します)。音も出すには: {}",
            doctor::install_command(&["pulseaudio"])
        );
    }
    Ok(())
}

/// `dew env`: シェルで eval できる形で、つなぐ設定を出す
fn env(args: &ServeArgs) -> anyhow::Result<()> {
    check_live_deps()?;
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
    cmd.arg("--foreground");
    if let Some(port) = args.port {
        cmd.arg("--port").arg(port.to_string());
    }
    // 子に DEW_PORT を引き継ぐと、指定がなかったことが分からなくなる
    cmd.env_remove("DEW_PORT")
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

/// 既定の閲覧範囲(7.2): `dir` を含む git リポジトリのルート。git 管理外なら $HOME、
/// $HOME の外なら `dir`(コンテナでは $HOME が空の /root で、ファイルは /workspace などにあるため。ADR 0021)。
/// git コマンドが入っていない環境もあるので、`.git` を親へたどって探す
fn default_root(dir: &Path) -> PathBuf {
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_owned());
    if let Some(d) = dir.ancestors().find(|d| d.join(".git").exists()) {
        return d.to_owned();
    }
    let home = state::home();
    let home = home.canonicalize().unwrap_or(home);
    if dir.starts_with(&home) { home } else { dir }
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
    let root_text = root.to_string_lossy().into_owned();
    let cfg = dew_server::Config {
        bind: args.bind,
        port: args.port,
        root,
        cache_dir: state::cache_dir(),
        jobs: args.jobs,
        home: cwd.canonicalize().unwrap_or(cwd),
        tls_dir: std::env::var_os("DEW_TLS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| state::data_dir().join("tls")),
        state_dir: state::data_dir(),
        csv: config::load().csv(),
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
            root: root_text,
        };
        if let Err(e) = state::write(&s) {
            tracing::error!("server.json を書けません: {e:#}");
        }
        print_url(&s);
    }));
    state::remove_if_owned(pid);
    result
}

fn stop(force: bool) -> anyhow::Result<()> {
    let Some(s) = state::read() else {
        println!("サーバは動いていません");
        return Ok(());
    };
    let api = Api::new(&s);
    if api.alive(&s.instance_id) {
        // activate 中のシェルがあれば確かめる(止めると、そのシェルのアプリは映らなくなる。13.6)
        if !force
            && let Ok(n) = api.shells()
            && n > 0
        {
            eprint!(
                "activate 中のシェルが {n} 個あります。止めると、そのシェルで起動するアプリは映らなくなります。停止しますか? [y/N] "
            );
            let mut answer = String::new();
            let _ = std::io::stdin().read_line(&mut answer);
            if !matches!(answer.trim(), "y" | "Y" | "yes") {
                eprintln!();
                println!("停止しませんでした(確認せずに止めるには dew stop --force)");
                return Ok(());
            }
        }
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
    println!("{}", term::link(&s.url));
}

/// 端末から開かせる URL(14.3)。開くとトークンを Cookie に移し、`path` があればそのファイルを開く
fn open_url(s: &ServerFile, path: Option<&str>) -> String {
    let base = s.url.split_once("/?").map_or(s.url.as_str(), |(b, _)| b);
    match path {
        Some(p) => format!(
            "{base}/open?path={}&token={}",
            term::query_escape(p),
            s.token
        ),
        None => format!("{base}/open?token={}", s.token),
    }
}

/// `dew url`(--open / --copy。14.6)
fn url(open: bool, copy: bool) -> anyhow::Result<()> {
    let s = running()?;
    if open && !term::open_in_browser(&open_url(&s, None)) {
        bail!("制御端末がないので、端末からブラウザを開けません");
    }
    if copy {
        if !term::copy(&s.url) {
            bail!("制御端末がないので、クリップボードにコピーできません");
        }
        eprintln!("dew: URL をクリップボードにコピーしました(端末が OSC 52 に対応している場合)");
    }
    print_url(&s);
    Ok(())
}

/// `dew activate`(13.3)。シェル関数から呼ばれ、シェルが eval するコードを標準出力に出す。
/// 知らせることは標準エラー出力へ(標準出力はシェルが読み取る)
fn activate(args: &ServeArgs, exact: bool, sh: &ShellArgs) -> anyhow::Result<()> {
    if !sh.emit_shell {
        return Err(shell::not_integrated("activate"));
    }
    if shell::active() {
        eprintln!("dew: すでに有効です。dew deactivate で戻します");
        return Ok(());
    }
    check_live_deps()?;
    let server = ensure_server(args)?;
    let api = Api::new(&server);
    let live = api.live_session()?;
    let exact = if exact {
        Some((
            hooks::install()?.to_string_lossy().into_owned(),
            live.exact_socket.clone(),
        ))
    } else {
        None
    };
    print!(
        "{}",
        shell::activate_code(&shell::Activate {
            env: &live.env,
            unset: &live.unset,
            exact,
        })
    );
    match sh.shell_pid {
        Some(pid) => {
            if let Err(e) = api.shell(pid, true) {
                eprintln!("dew: 注意: シェルをサーバに登録できません: {e:#}");
            }
        }
        None => eprintln!("dew: 注意: シェルの PID がないので、サーバに登録しません"),
    }
    eprintln!(
        "dew: 有効にしました(ディスプレイ {})。dew deactivate で戻します",
        live.display
    );
    Ok(())
}

/// `dew deactivate`(13.4)。サーバが止まっていても、環境変数は必ず戻す
fn deactivate(sh: &ShellArgs) -> anyhow::Result<()> {
    if !sh.emit_shell {
        return Err(shell::not_integrated("deactivate"));
    }
    if !shell::active() {
        eprintln!("dew: 有効になっていません");
        return Ok(());
    }
    print!("{}", shell::deactivate_code());
    if let (Some(pid), Some(s)) = (sh.shell_pid, alive()) {
        let _ = Api::new(&s).shell(pid, false);
    }
    eprintln!("dew: 元に戻しました");
    Ok(())
}

/// `dew rotate-token`(14.6)。動いているサーバにはすぐ効かせ、server.json も書き直す
fn rotate_token() -> anyhow::Result<()> {
    match alive() {
        Some(mut s) => {
            let token = Api::new(&s).rotate_token()?;
            s.url = s.url.replace(&s.token, &token);
            s.token = token;
            state::write(&s)?;
            println!(
                "トークンを作り直しました。接続中のタブは切れたので、次の URL から開き直してください"
            );
            print_url(&s);
        }
        None => {
            dew_server::rotate_token(&state::data_dir())?;
            println!("トークンを作り直しました。次に dew を起動したときから使います");
        }
    }
    Ok(())
}
