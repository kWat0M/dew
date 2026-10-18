//! ライブ表示の録画(L7)。ブラウザに表示している H.264 のフレームを、そのまま(再エンコードせず)MP4 に保存する。
//! 録画を始めたブラウザが、表示のために復号したフレームを表示した時刻付きで送り返してくる(巻き戻し中なら巻き戻した映像)。
//! それを FLV にし、ffmpeg に `-c copy` で MP4 へ詰め替えさせる(ADR 0015)

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, bail};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::stream::{Frame, nal_units, now_us};

pub struct Recorder {
    pub path: PathBuf,
    frames: mpsc::UnboundedSender<Frame>,
    stop: watch::Sender<bool>,
    /// 書き終わったら Some(結果)
    done: watch::Sender<Option<Result<(), String>>>,
}

impl Recorder {
    /// `path` への録画を始める。フレームは `push` で渡す(最初のキーフレームから書く)
    pub fn start(path: PathBuf) -> anyhow::Result<Arc<Self>> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("{} を作れません", dir.display()))?;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let rec = Arc::new(Self {
            path,
            frames: tx,
            stop: watch::channel(false).0,
            done: watch::channel(None).0,
        });
        let me = rec.clone();
        tokio::spawn(async move {
            let r = me.run(rx).await.map_err(|e| format!("{e:#}"));
            if let Err(e) = &r {
                tracing::warn!(path = %me.path.display(), "録画できません: {e}");
            }
            me.done.send_replace(Some(r));
        });
        Ok(rec)
    }

    /// 表示したフレームを1つ渡す(時刻は表示した時刻)
    pub fn push(&self, frame: Frame) {
        let _ = self.frames.send(frame);
    }

    /// 録画を止め、書き終わるまで待つ
    pub async fn stop(&self) -> anyhow::Result<PathBuf> {
        self.stop.send_replace(true);
        match self.finished().await {
            Ok(()) => Ok(self.path.clone()),
            Err(e) => bail!(e),
        }
    }

    /// 止めるよう頼むだけで、待たない(サーバを止めるとき)
    pub fn request_stop(&self) {
        self.stop.send_replace(true);
    }

    /// 書き終わるまで待つ
    pub async fn finished(&self) -> Result<(), String> {
        let mut rx = self.done.subscribe();
        let r = rx.wait_for(Option::is_some).await;
        match r {
            Ok(v) => v.clone().unwrap_or(Ok(())),
            Err(_) => Err("録画が途中で止まりました".into()),
        }
    }

    async fn run(&self, mut rx: mpsc::UnboundedReceiver<Frame>) -> anyhow::Result<()> {
        let mut child = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args([
                "-f",
                "flv",
                "-i",
                "-",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
            ])
            .arg(&self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("ffmpeg を起動できません")?;
        let mut stdin = child.stdin.take().expect("stdin");
        let mut flv = Flv::default();
        stdin.write_all(&flv.header()).await?;
        let mut stop = self.stop.subscribe();
        let mut wrote = 0usize;
        loop {
            tokio::select! {
                // wait_for の戻り値(読み取りの guard)を持ち越さないよう、中で捨てる
                _ = async { let _ = stop.wait_for(|s| *s).await; } => break,
                f = rx.recv() => match f {
                    Some(f) => {
                        // キーフレームから始める(途中のフレームからは復号できない)
                        if wrote == 0 && !f.key {
                            continue;
                        }
                        stdin.write_all(&flv.frame(&f)).await?;
                        wrote += 1;
                    }
                    None => break,
                },
            }
        }
        // 止めるまでに届いていた分も書く
        while let Ok(f) = rx.try_recv() {
            if wrote > 0 || f.key {
                stdin.write_all(&flv.frame(&f)).await?;
                wrote += 1;
            }
        }
        drop(stdin);
        let out = child.wait_with_output().await?;
        if wrote == 0 {
            let _ = std::fs::remove_file(&self.path);
            bail!("録画するフレームがありませんでした(録画を始めたタブが閉じられたかもしれません)");
        }
        if !out.status.success() {
            bail!(
                "MP4 にできません: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }
}

/// 録画のファイル名に使う、今の時刻(UTC、例 20261018-123456)
pub fn timestamp_name() -> String {
    let secs = now_us() / 1_000_000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // 1970-01-01 からの日数を年月日に(Howard Hinnant の civil_from_days)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

/// ファイル名に使えない文字を置き換える
pub fn safe_name(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if s.is_empty() { "live".into() } else { s }
}

/// 録画の保存先: `dir/<名前>-<時刻>.mp4`(同じ名前があれば番号を付ける)
pub fn path_for(dir: &Path, title: &str) -> PathBuf {
    let base = format!("{}-{}", safe_name(title), timestamp_name());
    let mut p = dir.join(format!("{base}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base}-{n}.mp4"));
        n += 1;
    }
    p
}

/// H.264 のフレームを FLV のタグにする。時刻は最初のフレームからのミリ秒
#[derive(Default)]
struct Flv {
    start_us: Option<u64>,
    /// SPS・PPS(AVCDecoderConfigurationRecord)を書いたか
    configured: bool,
}

impl Flv {
    fn header(&self) -> Vec<u8> {
        // "FLV"、版 1、映像あり、ヘッダの長さ 9、最初の PreviousTagSize 0
        vec![b'F', b'L', b'V', 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]
    }

    fn frame(&mut self, f: &Frame) -> Vec<u8> {
        let start = *self.start_us.get_or_insert(f.timestamp_us);
        let ms = (f.timestamp_us.saturating_sub(start) / 1000) as u32;
        let mut out = Vec::new();
        let nals: Vec<&[u8]> = nal_units(&f.data).collect();
        if f.key && !self.configured {
            let sps = nals.iter().find(|n| n[0] & 0x1f == 7);
            let pps = nals.iter().find(|n| n[0] & 0x1f == 8);
            if let (Some(sps), Some(pps)) = (sps, pps) {
                let mut rec = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
                rec.extend_from_slice(&(sps.len() as u16).to_be_bytes());
                rec.extend_from_slice(sps);
                rec.push(1);
                rec.extend_from_slice(&(pps.len() as u16).to_be_bytes());
                rec.extend_from_slice(pps);
                out.extend(tag(ms, 0x17, 0, &rec));
                self.configured = true;
            }
        }
        // AUD・SPS・PPS は除き、長さ(4バイト)付きの NAL を並べる
        let mut body = Vec::with_capacity(f.data.len());
        for n in nals.iter().filter(|n| !matches!(n[0] & 0x1f, 7..=9)) {
            body.extend_from_slice(&(n.len() as u32).to_be_bytes());
            body.extend_from_slice(n);
        }
        out.extend(tag(ms, if f.key { 0x17 } else { 0x27 }, 1, &body));
        out
    }
}

/// FLV の映像タグ(`kind`: 上位4ビットがキーフレームか、下位4ビットが AVC。`packet`: 0 設定、1 NAL)
fn tag(ms: u32, kind: u8, packet: u8, payload: &[u8]) -> Vec<u8> {
    let size = (payload.len() + 5) as u32;
    let mut t = Vec::with_capacity(11 + size as usize + 4);
    t.push(9);
    t.extend_from_slice(&size.to_be_bytes()[1..]);
    t.extend_from_slice(&ms.to_be_bytes()[1..]);
    t.push((ms >> 24) as u8);
    t.extend_from_slice(&[0, 0, 0]);
    t.extend_from_slice(&[kind, packet, 0, 0, 0]);
    t.extend_from_slice(payload);
    t.extend_from_slice(&(11 + size).to_be_bytes());
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_name("Figure 1"), "Figure_1");
        assert_eq!(safe_name("a/b"), "a_b");
        assert_eq!(safe_name(""), "live");
        let t = timestamp_name();
        assert_eq!(t.len(), 15, "{t}");
        assert_eq!(&t[8..9], "-");
    }

    /// 本物の H.264(ffmpeg で作る)を FLV にして MP4 へ詰め替え、長さが時刻どおりになる
    #[tokio::test]
    async fn flv_remuxes_to_mp4_with_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let h264 = std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x240:r=30:d=3",
            ])
            .args([
                "-c:v", "libx264", "-g", "30", "-bf", "0", "-pix_fmt", "yuv420p",
            ])
            .args(["-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "-"])
            .output()
            .unwrap()
            .stdout;
        let frames = crate::stream::split_frames(&h264);
        assert_eq!(frames.len(), 90);
        let mut flv = Flv::default();
        let mut data = flv.header();
        for (i, (key, d)) in frames.into_iter().enumerate() {
            let f = Frame {
                key,
                timestamp_us: 1_000_000 + i as u64 * 33_333,
                data: d,
            };
            data.extend(flv.frame(&f));
        }
        let flv_path = dir.path().join("a.flv");
        let mp4 = dir.path().join("a.mp4");
        std::fs::write(&flv_path, data).unwrap();
        let ok = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&flv_path)
            .args(["-c", "copy"])
            .arg(&mp4)
            .status()
            .unwrap();
        assert!(ok.success());
        let dur: f64 = String::from_utf8(
            std::process::Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&mp4)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        assert!((dur - 3.0).abs() < 0.1, "{dur}");
    }
}
