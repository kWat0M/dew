//! ffmpeg / ffprobe の呼び出し(CLI をサブプロセスで使う)と、その結果のキャッシュ。
//! 調査(probe)、サムネイル、シークバー用のスプライト、ブラウザで再生できない形式の変換

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use dew_protocol::{Probe, Sprite};
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Semaphore;

/// 変換するときのセグメントの長さ(7.4)
pub const SEGMENT_SECS: f64 = 6.0;
/// サムネイルの幅(9.1)
const THUMB_WIDTH: u32 = 320;
/// シークバーのプレビューの間隔と幅(9.1)
const SPRITE_INTERVAL: f64 = 10.0;
const SPRITE_WIDTH: u32 = 160;
const SPRITE_COLS: u32 = 10;
/// WebP の1辺の上限
const WEBP_MAX: u32 = 16_383;
/// キャッシュの形式を変えたら上げる(古いキャッシュを使わないため)
const CACHE_VERSION: u32 = 1;

pub struct Media {
    dir: PathBuf,
    limit_bytes: u64,
    jobs: Semaphore,
    /// 同じ結果を同時に2回作らないための鍵ごとのロック
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// キャッシュから返したか、今作ったか
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cache {
    Hit,
    Miss,
}

impl Media {
    /// `dir` にキャッシュを置き、合計が `limit_bytes` を超えたら古い順に消す。ffmpeg の同時実行は `jobs` 個まで
    pub fn new(dir: PathBuf, limit_bytes: u64, jobs: usize) -> Self {
        Self {
            dir,
            limit_bytes,
            jobs: Semaphore::new(jobs.max(1)),
            locks: Mutex::default(),
        }
    }

    /// 長さ・コーデック・フレームごとの時刻など(7.5)
    pub async fn probe(&self, src: &Path) -> anyhow::Result<Probe> {
        let (path, _) = self
            .cached(src, "probe", "json", |out| async move {
                let probe = run_probe(src).await?;
                tokio::fs::write(&out, serde_json::to_vec(&probe)?).await?;
                Ok(())
            })
            .await?;
        Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
    }

    /// 幅 320px の WebP。動画は 10% の位置の画面
    pub async fn thumb(&self, src: &Path, video: bool) -> anyhow::Result<PathBuf> {
        let at = if video {
            self.probe(src).await?.duration * 0.1
        } else {
            0.0
        };
        let (path, _) = self
            .cached(src, "thumb", "webp", |out| async move {
                let mut args = vec![];
                if video {
                    args.extend(["-ss".to_owned(), format!("{at:.3}")]);
                }
                args.extend(["-i".to_owned(), path_arg(src)]);
                args.extend(
                    [
                        "-frames:v",
                        "1",
                        "-vf",
                        &format!("scale='min({THUMB_WIDTH},iw)':-2"),
                        "-c:v",
                        "libwebp",
                        "-quality",
                        "80",
                        "-f",
                        "webp",
                    ]
                    .map(str::to_owned),
                );
                args.push(path_arg(&out));
                self.ffmpeg(&args, true).await
            })
            .await?;
        Ok(path)
    }

    /// シークバー用のサムネイル列(1枚の WebP)。並びは probe の `sprite`
    pub async fn sprite(&self, src: &Path) -> anyhow::Result<PathBuf> {
        let probe = self.probe(src).await?;
        let Some(sp) = probe.sprite else {
            bail!("映像がありません")
        };
        let (path, _) = self
            .cached(src, "sprite", "webp", |out| async move {
                let rows = sp.count.div_ceil(sp.cols);
                let vf = format!(
                    "fps=1/{},scale={}:{},tile={}x{rows}",
                    sp.interval, sp.tile_width, sp.tile_height, sp.cols
                );
                // キーフレームだけ復号して速くする(位置は最寄りのキーフレームになる)
                let args = [
                    "-skip_frame",
                    "nokey",
                    "-i",
                    &path_arg(src),
                    "-vf",
                    &vf,
                    "-frames:v",
                    "1",
                ]
                .into_iter()
                .chain([
                    "-c:v",
                    "libwebp",
                    "-quality",
                    "70",
                    "-f",
                    "webp",
                    &path_arg(&out),
                ])
                .map(str::to_owned)
                .collect::<Vec<_>>();
                self.ffmpeg(&args, true).await
            })
            .await?;
        Ok(path)
    }

    /// ブラウザで正確に表示できない画像(TIFF、16bit など)を、表示用の 8bit RGBA の PNG にする
    pub async fn display_png(&self, src: &Path) -> anyhow::Result<PathBuf> {
        let (path, _) = self
            .cached(src, "display", "png", |out| async move {
                let args = [
                    "-i",
                    &path_arg(src),
                    "-frames:v",
                    "1",
                    "-pix_fmt",
                    "rgba",
                    "-c:v",
                    "png",
                    "-f",
                    "image2",
                    &path_arg(&out),
                ]
                .map(str::to_owned);
                self.ffmpeg(&args, false).await
            })
            .await?;
        Ok(path)
    }

    /// 画像の元の画素値(16bit RGBA、リトルエンディアン、左上から行ごと)。ピクセル値の表示に使う(F8)
    pub async fn pixels16(&self, src: &Path) -> anyhow::Result<PathBuf> {
        let (path, _) = self
            .cached(src, "rgba64", "raw", |out| async move {
                let args = [
                    "-i",
                    &path_arg(src),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgba64le",
                    &path_arg(&out),
                ]
                .map(str::to_owned);
                self.ffmpeg(&args, false).await
            })
            .await?;
        Ok(path)
    }

    /// 変換した `index` 番目のセグメント(H.264 / AAC の fragmented MP4、7.4)。
    /// 各セグメントは初期化部分を含んで単独で再生でき、時刻は 0 秒から始まる。
    /// ブラウザは SourceBuffer の timestampOffset を `index * SEGMENT_SECS` にして並べる
    /// (fragmented MP4 では -output_ts_offset が効かないため)
    pub async fn segment(&self, src: &Path, index: u32) -> anyhow::Result<(PathBuf, Cache)> {
        let probe = self.probe(src).await?;
        if index >= probe.segment_count {
            bail!(
                "セグメント {index} はありません(全 {} 個)",
                probe.segment_count
            );
        }
        let start = f64::from(index) * SEGMENT_SECS;
        let has_audio = probe.audio_codec.is_some();
        self.cached(src, &format!("seg{index}"), "mp4", |out| async move {
            let mut args: Vec<String> = ["-ss", &format!("{start:.3}"), "-i", &path_arg(src)]
                .into_iter()
                .chain(["-t", &format!("{SEGMENT_SECS}"), "-map", "0:v:0"])
                .chain([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-profile:v",
                    "high",
                ])
                // B フレームがあると先頭の表示時刻が 0 からずれる
                .chain(["-bf", "0"])
                .chain([
                    "-pix_fmt",
                    "yuv420p",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                ])
                .map(str::to_owned)
                .collect();
            if has_audio {
                args.extend(
                    ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k", "-ac", "2"].map(str::to_owned),
                );
            }
            args.extend(
                // AAC の先頭の無音(負の時刻)に合わせて映像を後ろへずらさない
                ["-avoid_negative_ts", "make_non_negative"]
                    .into_iter()
                    .chain([
                        "-movflags",
                        "frag_keyframe+empty_moov+default_base_moof",
                        "-f",
                        "mp4",
                    ])
                    .map(str::to_owned),
            );
            args.push(path_arg(&out));
            self.ffmpeg(&args, false).await
        })
        .await
    }

    /// `src` と `kind` で決まるキャッシュを返す。なければ `make` で一時ファイルに作ってから置く
    async fn cached<F, Fut>(
        &self,
        src: &Path,
        kind: &str,
        ext: &str,
        make: F,
    ) -> anyhow::Result<(PathBuf, Cache)>
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = anyhow::Result<()>>,
    {
        let key = cache_key(src, kind)?;
        let path = self.dir.join(format!("{key}.{ext}"));
        let lock = self
            .locks
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_default()
            .clone();
        let _guard = lock.lock().await;
        if path.exists() {
            touch(&path);
            return Ok((path, Cache::Hit));
        }
        tokio::fs::create_dir_all(&self.dir).await?;
        let tmp = self.dir.join(format!("{key}.tmp.{ext}"));
        let made = make(tmp.clone()).await;
        if let Err(e) = made {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
        tokio::fs::rename(&tmp, &path).await?;
        self.locks.lock().unwrap().remove(&key);
        let (dir, limit) = (self.dir.clone(), self.limit_bytes);
        tokio::task::spawn_blocking(move || evict(&dir, limit));
        Ok((path, Cache::Miss))
    }

    /// ffmpeg を実行する。`background` ならサムネイル用に優先度を下げる(nice 10。7.3)
    async fn ffmpeg(&self, args: &[String], background: bool) -> anyhow::Result<()> {
        let _permit = self.jobs.acquire().await?;
        let mut cmd = if background {
            let mut c = Command::new("nice");
            c.args(["-n", "10", "ffmpeg"]);
            c
        } else {
            Command::new("ffmpeg")
        };
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args(args);
        let out = cmd
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .context("ffmpeg を起動できません")?;
        if !out.status.success() {
            bail!("ffmpeg が失敗しました: {}", summary(&out.stderr));
        }
        Ok(())
    }
}

async fn run_probe(src: &Path) -> anyhow::Result<Probe> {
    let out = ffprobe(
        &["-show_format", "-show_streams", "-print_format", "json"],
        src,
    )
    .await?;
    let info: Value = serde_json::from_slice(&out)?;
    let streams = info["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let num = |v: &Value| v.as_str().and_then(|s| s.parse::<f64>().ok());
    let duration = num(&info["format"]["duration"])
        .or_else(|| video.and_then(|v| num(&v["duration"])))
        .unwrap_or(0.0);
    let fps = video
        .and_then(|v| v["avg_frame_rate"].as_str())
        .and_then(rational)
        .unwrap_or(0.0);
    let width = video.and_then(|v| v["width"].as_u64()).unwrap_or(0) as u32;
    let height = video.and_then(|v| v["height"].as_u64()).unwrap_or(0) as u32;
    let video_codec = video
        .and_then(|v| v["codec_name"].as_str())
        .map(str::to_owned);
    let audio_codec = audio
        .and_then(|a| a["codec_name"].as_str())
        .map(str::to_owned);
    let pix_fmt = video.and_then(|v| v["pix_fmt"].as_str()).unwrap_or("");
    let format = info["format"]["format_name"].as_str().unwrap_or("");

    let bit_depth = bit_depth(pix_fmt);
    // 画像: ブラウザで正確に表示できない形式だけを変換の対象にする(F8、2.6)
    if is_image(src) {
        return Ok(Probe {
            duration: 0.0,
            fps: 0.0,
            width,
            height,
            video_codec,
            audio_codec: None,
            needs_transcode: bit_depth > 8 || !browser_image(src),
            bit_depth,
            segment_secs: SEGMENT_SECS,
            segment_count: 0,
            frame_times: Vec::new(),
            sprite: None,
        });
    }
    let needs_transcode = !playable(
        format,
        src,
        video_codec.as_deref(),
        pix_fmt,
        audio_codec.as_deref(),
    );
    let mut frame_times = Vec::new();
    if video.is_some() {
        let out = ffprobe(
            &[
                "-select_streams",
                "v:0",
                "-show_entries",
                "packet=pts_time",
                "-of",
                "csv=p=0",
            ],
            src,
        )
        .await?;
        frame_times = String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(',').parse().ok())
            .collect();
        frame_times.sort_by(f64::total_cmp);
        // 変換したものは先頭が 0 秒から始まる
        if needs_transcode && let Some(&first) = frame_times.first() {
            frame_times.iter_mut().for_each(|t| *t -= first);
        }
    }
    let sprite = (width > 0 && duration > 0.0).then(|| sprite_layout(duration, width, height));
    Ok(Probe {
        duration,
        fps,
        width,
        height,
        video_codec,
        audio_codec,
        needs_transcode,
        bit_depth,
        segment_secs: SEGMENT_SECS,
        segment_count: (duration / SEGMENT_SECS).ceil().max(1.0) as u32,
        frame_times,
        sprite,
    })
}

fn ext(src: &Path) -> String {
    src.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_image(src: &Path) -> bool {
    matches!(
        ext(src).as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "bmp" | "tif" | "tiff"
    )
}

/// ブラウザがそのまま表示できる画像の形式(2.6)
fn browser_image(src: &Path) -> bool {
    matches!(
        ext(src).as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "bmp"
    )
}

/// ffmpeg の画素形式から、1色あたりのビット数
fn bit_depth(pix_fmt: &str) -> u32 {
    let deep = [
        "48", "64", "gray16", "ya16", "p10", "p12", "p14", "p16", "f32", "gbrpf",
    ];
    if deep.iter().any(|d| pix_fmt.contains(d)) {
        16
    } else {
        8
    }
}

/// Windows の Chrome / Edge がそのまま再生できるか(2.6)
fn playable(
    format: &str,
    src: &Path,
    video: Option<&str>,
    pix_fmt: &str,
    audio: Option<&str>,
) -> bool {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let container = match ext.as_str() {
        "mp4" | "m4v" | "mov" => format.contains("mp4"),
        "webm" | "mkv" => format.contains("matroska"),
        "mp3" | "m4a" | "aac" | "ogg" | "opus" | "flac" | "wav" => true,
        _ => false,
    };
    let video_ok = match video {
        None => true,
        // 10bit や 4:4:4 の H.264 は Chrome で再生できない
        Some("h264") => matches!(pix_fmt, "yuv420p" | "yuvj420p"),
        Some(c) => matches!(c, "vp8" | "vp9" | "av1"),
    };
    let audio_ok =
        audio.is_none_or(|a| matches!(a, "aac" | "opus" | "mp3" | "vorbis" | "flac" | "pcm_s16le"));
    container && video_ok && audio_ok
}

/// 1枚の WebP に収まるよう、長い動画では間隔を広げる
fn sprite_layout(duration: f64, width: u32, height: u32) -> Sprite {
    let tile_width = SPRITE_WIDTH.min(width);
    let tile_height =
        ((f64::from(height) * f64::from(tile_width) / f64::from(width)) / 2.0).round() as u32 * 2;
    let max_count = (WEBP_MAX / tile_height.max(2)) * SPRITE_COLS;
    let mut interval = SPRITE_INTERVAL;
    if (duration / interval).ceil() as u32 > max_count {
        interval = (duration / f64::from(max_count)).ceil();
    }
    let count = ((duration / interval).ceil() as u32).max(1);
    Sprite {
        interval,
        count,
        cols: SPRITE_COLS.min(count),
        tile_width,
        tile_height: tile_height.max(2),
    }
}

async fn ffprobe(args: &[&str], src: &Path) -> anyhow::Result<Vec<u8>> {
    let out = Command::new("ffprobe")
        .args(["-v", "error"])
        .args(args)
        .arg(path_arg(src))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .context("ffprobe を起動できません")?;
    if !out.status.success() {
        bail!("ffprobe が失敗しました: {}", summary(&out.stderr));
    }
    Ok(out.stdout)
}

fn rational(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d != 0.0).then(|| n / d)
}

/// ffmpeg のエラー出力の要約(最後の数行。7.11)
fn summary(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<_> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join(" / ")
}

/// `-` で始まるファイル名がオプションと取り違えられないようにする
fn path_arg(p: &Path) -> String {
    format!("file:{}", p.display())
}

/// 元ファイルのパス・大きさ・更新時刻から作るキャッシュの鍵。元ファイルが変われば鍵も変わる
fn cache_key(src: &Path, kind: &str) -> anyhow::Result<String> {
    let meta = std::fs::metadata(src).with_context(|| format!("{} を読めません", src.display()))?;
    let mtime = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut h = std::hash::DefaultHasher::new();
    (CACHE_VERSION, src, meta.len(), mtime.as_nanos()).hash(&mut h);
    Ok(format!("{:016x}-{kind}", h.finish()))
}

/// 使ったキャッシュの更新時刻を新しくする(古い順に消すときの順番に使う)
fn touch(p: &Path) {
    if let Ok(f) = std::fs::File::options().append(true).open(p) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// 合計が上限を超えていたら、更新時刻の古いものから消す
fn evict(dir: &Path, limit: u64) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file()
                .then(|| (m.modified().unwrap_or(UNIX_EPOCH), m.len(), e.path()))
        })
        .filter(|(t, _, p)| {
            // 作りかけの一時ファイルは、しばらく経っていなければ残す
            !p.to_string_lossy().contains(".tmp.")
                || t.elapsed().unwrap_or_default() > Duration::from_secs(3600)
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playable_formats() {
        let mp4 = "mov,mp4,m4a,3gp,3g2,mj2";
        assert!(playable(
            mp4,
            Path::new("a.mp4"),
            Some("h264"),
            "yuv420p",
            Some("aac")
        ));
        assert!(
            !playable(
                mp4,
                Path::new("a.mp4"),
                Some("mpeg4"),
                "yuv420p",
                Some("aac")
            ),
            "mp4v"
        );
        assert!(
            !playable(mp4, Path::new("a.mp4"), Some("h264"), "yuv420p10le", None),
            "10bit"
        );
        assert!(
            !playable(
                "avi",
                Path::new("a.avi"),
                Some("h264"),
                "yuv420p",
                Some("mp3")
            ),
            "AVI"
        );
        assert!(playable(
            "matroska,webm",
            Path::new("a.webm"),
            Some("vp9"),
            "yuv420p",
            Some("opus")
        ));
        assert!(!playable(
            mp4,
            Path::new("a.mp4"),
            Some("h264"),
            "yuv420p",
            Some("ac3")
        ));
    }

    #[test]
    fn bit_depth_from_pix_fmt() {
        assert_eq!(bit_depth("rgb24"), 8);
        assert_eq!(bit_depth("rgba"), 8);
        assert_eq!(bit_depth("rgb48be"), 16);
        assert_eq!(bit_depth("rgba64le"), 16);
        assert_eq!(bit_depth("gray16be"), 16);
        assert_eq!(bit_depth("yuv420p10le"), 16);
    }

    #[test]
    fn sprite_fits_in_one_webp() {
        let s = sprite_layout(10.0, 640, 360);
        assert_eq!(
            (s.count, s.cols, s.tile_width, s.tile_height, s.interval),
            (1, 1, 160, 90, 10.0)
        );
        let s = sprite_layout(10.0 * 3600.0, 1920, 1080);
        let rows = s.count.div_ceil(s.cols);
        assert!(rows * s.tile_height <= WEBP_MAX, "{s:?}");
        assert!(s.interval > 10.0);
    }

    #[test]
    fn evicts_oldest_first() {
        let dir = tempfile::TempDir::new().unwrap();
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            let p = dir.path().join(name);
            std::fs::write(&p, [0u8; 100]).unwrap();
            let f = std::fs::File::options().append(true).open(&p).unwrap();
            f.set_modified(UNIX_EPOCH + Duration::from_secs(1000 + i as u64))
                .unwrap();
        }
        evict(dir.path(), 200);
        assert!(!dir.path().join("a").exists());
        assert!(dir.path().join("b").exists() && dir.path().join("c").exists());
    }
}
