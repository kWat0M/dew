//! 実行時の依存の確認(3.1 の dew doctor、7.10)。機能ごとに要るツールを示し、足りなければ apt の導入コマンドを出す。
//! ツールがなくても、そのツールを使わない機能は動く(ADR 0019)

use std::path::Path;

/// 外部のツール
struct Tool {
    /// どれか1つあればよいコマンド
    commands: &'static [&'static str],
    /// 入れる apt のパッケージ
    package: &'static str,
}

const FFMPEG: Tool = Tool {
    commands: &["ffmpeg"],
    package: "ffmpeg",
};
const FFPROBE: Tool = Tool {
    commands: &["ffprobe"],
    package: "ffmpeg",
};
const XVFB: Tool = Tool {
    commands: &["Xvfb"],
    package: "xvfb",
};
const PULSE: Tool = Tool {
    commands: &["pulseaudio", "pipewire"],
    package: "pulseaudio",
};

/// 機能と、それに要るツール
struct Feature {
    name: &'static str,
    tools: &'static [&'static Tool],
    /// 足りないとき、どうなるか
    without: &'static str,
}

const FEATURES: &[Feature] = &[
    Feature {
        name: "ファイルの閲覧・再生(MP4・WebM・PNG・JPEG など)",
        tools: &[],
        without: "",
    },
    Feature {
        name: "動画の情報(長さ・解像度)・フレーム番号・コマ送り",
        tools: &[&FFPROBE],
        without: "再生はできるが、情報とコマ送りは出ない",
    },
    Feature {
        name: "サムネイル・シークバーのプレビュー",
        tools: &[&FFMPEG],
        without: "アイコンを出す",
    },
    Feature {
        name: "ブラウザで再生できない形式(mp4v・AVI・TIFF・16bit など)の変換",
        tools: &[&FFMPEG, &FFPROBE],
        without: "開くときに理由と入れ方を出す",
    },
    Feature {
        name: "ライブ描画(dew run / dew env)",
        tools: &[&XVFB, &FFMPEG],
        without: "dew run が理由と入れ方を出して止まる",
    },
    Feature {
        name: "ライブ描画の音",
        tools: &[&PULSE],
        without: "映像だけを映す",
    },
    Feature {
        name: "録画",
        tools: &[&FFMPEG],
        without: "録画を始めるときに理由と入れ方を出す",
    },
];

fn found(cmd: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|d| is_executable(&d.join(cmd))))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn has(t: &Tool) -> bool {
    t.commands.iter().any(|c| found(c))
}

/// 足りないツールのパッケージ(重複なし)
fn missing_packages(tools: &[&Tool]) -> Vec<&'static str> {
    let mut pkgs: Vec<&'static str> = Vec::new();
    for t in tools {
        if !has(t) && !pkgs.contains(&t.package) {
            pkgs.push(t.package);
        }
    }
    pkgs
}

/// 起動時に知らせる、ツールが足りなくて使えない機能(機能の名前、入れるパッケージ)
pub fn unavailable() -> Vec<(&'static str, Vec<&'static str>)> {
    FEATURES
        .iter()
        .filter_map(|f| {
            let pkgs = missing_packages(f.tools);
            (!pkgs.is_empty()).then_some((f.name, pkgs))
        })
        .collect()
}

/// ライブ描画(dew run / dew env)に欠かせないもので足りないもの(仮想ディスプレイの Xvfb と、映像の取り込みの ffmpeg)。
/// 音声サーバは、なくても音なしで映せるので含めない
pub fn missing_live() -> Vec<&'static str> {
    missing_packages(&[&XVFB, &FFMPEG])
}

/// 音声サーバ(pulseaudio か pipewire)があるか
pub fn has_audio() -> bool {
    has(&PULSE)
}

pub fn install_command(pkgs: &[&str]) -> String {
    format!("sudo apt-get install -y {}", pkgs.join(" "))
}

/// `dew doctor --help` に載せる、yazi から dew で開く設定の例(14.7)。
/// `orphan = true` は付けない(制御端末がなくなり、端末からブラウザを開けなくなる)
pub const HELP: &str =
    "依存(ffmpeg、Xvfb、音声サーバ、GPU)と、端末との連携(tmux、WezTerm)を確認する

yazi から dew で開くには、~/.config/yazi/yazi.toml に次を足す(orphan = true は付けない。
dew はすぐ終わるので要らず、付けると端末からブラウザを開けなくなる):

  [opener]
  dew = [
    { run = 'dew \"$@\"', desc = \"dew で開く\", for = \"unix\" },
  ]

  [open]
  prepend_rules = [
    { mime = \"video/*\", use = [\"dew\", \"play\"] },
    { mime = \"image/*\", use = [\"dew\"] },
    { url = \"*.csv\", use = [\"dew\", \"edit\"] },
    { url = \"*.tsv\", use = [\"dew\", \"edit\"] },
    { url = \"*.md\", use = [\"edit\", \"dew\"] },
  ]";

/// tmux の allow-passthrough。tmux の中でなければ None
fn tmux_passthrough() -> Option<String> {
    std::env::var_os("TMUX").filter(|v| !v.is_empty())?;
    let out = std::process::Command::new("tmux")
        .args(["show-options", "-gv", "allow-passthrough"])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// 端末との連携(14章)
fn terminal() {
    println!("\n端末との連携(タブがないときに、dew <ファイル> から端末経由でブラウザを開く)");
    match tmux_passthrough() {
        Some(v) if v == "on" || v == "all" => println!("✓ tmux: allow-passthrough は {v}"),
        Some(_) => println!(
            "✗ tmux: allow-passthrough がオフです。~/.tmux.conf に set -g allow-passthrough on を足すと、tmux の中からも開けます"
        ),
        None => {}
    }
    println!("- WezTerm で開くには、dew setup-wezterm が出す設定を wezterm.lua に足す(任意)");
    println!("- yazi から開く設定の例: dew doctor --help");
}

/// `dew doctor`
pub fn run() {
    println!("機能ごとに要るツール(ツールがなくても、ほかの機能は使えます)\n");
    let mut all: Vec<&'static str> = Vec::new();
    for f in FEATURES {
        let pkgs = missing_packages(f.tools);
        let tools = if f.tools.is_empty() {
            "ツールは要りません".to_owned()
        } else {
            f.tools
                .iter()
                .map(|t| {
                    format!(
                        "{} {}",
                        if has(t) { "✓" } else { "✗" },
                        t.commands.join(" / ")
                    )
                })
                .collect::<Vec<_>>()
                .join("  ")
        };
        println!("{} {}", if pkgs.is_empty() { "✓" } else { "✗" }, f.name);
        println!("    {tools}");
        if !pkgs.is_empty() {
            println!("    → 今は使えません({})", f.without);
        }
        for p in pkgs {
            if !all.contains(&p) {
                all.push(p);
            }
        }
    }
    // ライブ映像のエンコーダ(NVENC が実際に使えるか。ADR 0014)
    if has(&FFMPEG) {
        let enc = dew_capture::encoder::Encoder::detect("ffmpeg");
        println!(
            "- ライブ映像のエンコード: {}",
            match enc {
                dew_capture::encoder::Encoder::Nvenc => "NVENC(GPU)を使います",
                dew_capture::encoder::Encoder::X264 =>
                    "NVENC が使えないので libx264(CPU)を使います",
            }
        );
    }
    terminal();
    if all.is_empty() {
        println!("\nすべての機能が使えます");
    } else {
        println!(
            "\n足りないものは次のコマンドで入れられます:\n  {}",
            install_command(&all)
        );
    }
}
