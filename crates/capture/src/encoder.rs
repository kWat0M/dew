//! ライブ映像のエンコーダの選択(3.4、7.3、9 章のフェーズ4)。NVENC(h264_nvenc)が使えればそちらに逃がし、
//! 使えなければ libx264 にする。ffmpeg に h264_nvenc が入っていても GPU やドライバがないと使えないので、
//! 小さな画像を実際にエンコードして確かめる(ADR 0014)

use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    Nvenc,
    X264,
}

impl Encoder {
    /// 使うエンコーダ(最初の1回だけ確かめ、以降は覚えておく)。`DEW_ENCODER=libx264` か `nvenc` で決め打ちにできる
    pub fn current() -> Self {
        static CURRENT: OnceLock<Encoder> = OnceLock::new();
        *CURRENT.get_or_init(|| {
            let e = match std::env::var("DEW_ENCODER").as_deref() {
                Ok("libx264") => Self::X264,
                Ok("nvenc") => Self::Nvenc,
                _ => Self::detect("ffmpeg"),
            };
            tracing::info!(encoder = e.name(), "ライブ映像のエンコーダ");
            e
        })
    }

    /// `ffmpeg` で h264_nvenc が実際に使えるかを確かめる
    pub fn detect(ffmpeg: &str) -> Self {
        let child = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(["-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1"])
            .args(["-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            return Self::X264;
        };
        // ドライバの初期化で固まっても、起動が止まらないようにする
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Self::Nvenc,
                Ok(Some(_)) | Err(_) => return Self::X264,
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Self::X264
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Nvenc => "h264_nvenc",
            Self::X264 => "libx264",
        }
    }

    /// ffmpeg に渡すエンコードの設定(B フレームなし、低遅延。キーフレームの間隔は `gop` フレーム)
    pub fn args(self, gop: u32) -> Vec<String> {
        let v: &[&str] = match self {
            // p1 が最も速い。ull は超低遅延向けの調整
            Self::Nvenc => &[
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p1",
                "-tune",
                "ull",
                "-zerolatency",
                "1",
            ],
            // 共有サーバでほかの人の CPU を使い切らないよう、最大 2 スレッド(7.3)
            Self::X264 => &[
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-threads",
                "2",
            ],
        };
        let mut out: Vec<String> = v.iter().map(|s| (*s).to_owned()).collect();
        out.extend(["-pix_fmt", "yuv420p", "-g", &gop.to_string(), "-bf", "0"].map(String::from));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// 終了コードだけを返す偽の ffmpeg
    fn fake_ffmpeg(code: i32) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ffmpeg");
        std::fs::write(&path, format!("#!/bin/sh\nexit {code}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = path.to_string_lossy().into_owned();
        (dir, p)
    }

    #[test]
    fn uses_nvenc_when_it_works() {
        let (_d, ffmpeg) = fake_ffmpeg(0);
        assert_eq!(Encoder::detect(&ffmpeg), Encoder::Nvenc);
    }

    #[test]
    fn falls_back_to_x264_when_nvenc_fails() {
        let (_d, ffmpeg) = fake_ffmpeg(1);
        assert_eq!(Encoder::detect(&ffmpeg), Encoder::X264);
        assert_eq!(Encoder::detect("/nonexistent/ffmpeg"), Encoder::X264);
    }

    /// 本物の ffmpeg で確かめる。GPU のない環境(開発用コンテナ)では libx264 になる
    #[test]
    fn real_ffmpeg_without_gpu_uses_x264() {
        if std::path::Path::new("/dev/nvidia0").exists() {
            assert_eq!(Encoder::detect("ffmpeg"), Encoder::Nvenc);
        } else {
            assert_eq!(Encoder::detect("ffmpeg"), Encoder::X264);
        }
    }

    #[test]
    fn args_have_no_b_frames_and_gop() {
        for e in [Encoder::Nvenc, Encoder::X264] {
            let a = e.args(60).join(" ");
            assert!(
                a.contains(e.name()) && a.contains("-g 60") && a.contains("-bf 0"),
                "{a}"
            );
        }
    }
}
