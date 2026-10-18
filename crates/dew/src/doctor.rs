//! 実行時の依存の確認(3.1 の dew doctor、7.10)。足りなければ apt の導入コマンドを表示する

use std::path::Path;

struct Dep {
    /// どれか1つあればよいコマンド
    commands: &'static [&'static str],
    package: &'static str,
    /// 何に使うか
    purpose: &'static str,
    /// ファイル閲覧に必須か(false ならライブ描画のときだけ要る)
    required: bool,
}

const DEPS: &[Dep] = &[
    Dep {
        commands: &["ffmpeg"],
        package: "ffmpeg",
        purpose: "変換・サムネイル",
        required: true,
    },
    Dep {
        commands: &["ffprobe"],
        package: "ffmpeg",
        purpose: "動画の調査",
        required: true,
    },
    Dep {
        commands: &["Xvfb"],
        package: "xvfb",
        purpose: "ライブ描画の仮想ディスプレイ",
        required: false,
    },
    Dep {
        commands: &["pulseaudio", "pipewire"],
        package: "pulseaudio",
        purpose: "ライブ描画の音声",
        required: false,
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

/// ファイル閲覧に必須で足りないもの。起動時の警告に使う
pub fn missing_required() -> Vec<&'static str> {
    let mut pkgs: Vec<_> = DEPS
        .iter()
        .filter(|d| d.required && !d.commands.iter().any(|c| found(c)))
        .map(|d| d.package)
        .collect();
    pkgs.dedup();
    pkgs
}

pub fn install_command(pkgs: &[&str]) -> String {
    format!("sudo apt-get install -y {}", pkgs.join(" "))
}

/// `dew doctor`
pub fn run() {
    let mut missing = Vec::new();
    for d in DEPS {
        let ok = d.commands.iter().any(|c| found(c));
        let need = if d.required {
            "必須"
        } else {
            "ライブ描画"
        };
        println!(
            "{} {:<22} {}({need})",
            if ok { "✓" } else { "✗" },
            d.commands.join(" / "),
            d.purpose
        );
        if !ok && !missing.contains(&d.package) {
            missing.push(d.package);
        }
    }
    // ライブ映像のエンコーダ(NVENC が実際に使えるか。ADR 0014)
    let enc = dew_capture::encoder::Encoder::detect("ffmpeg");
    println!(
        "{} {:<22} ライブ映像のエンコード: {}",
        if enc == dew_capture::encoder::Encoder::Nvenc {
            "✓"
        } else {
            "-"
        },
        "NVENC(任意)",
        match enc {
            dew_capture::encoder::Encoder::Nvenc => "NVENC(GPU)を使います",
            dew_capture::encoder::Encoder::X264 => "NVENC が使えないので libx264(CPU)を使います",
        }
    );
    if missing.is_empty() {
        println!("\n必要なものはそろっています");
    } else {
        println!(
            "\n足りないものは次のコマンドで入れられます:\n  {}",
            install_command(&missing)
        );
    }
}
