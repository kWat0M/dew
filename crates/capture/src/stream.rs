//! ウィンドウ1つの映像の配信(6.1 の 3)。ffmpeg の `x11grab -window_id` で取り込み、libx264 で H.264 にして、
//! フレーム(アクセスユニット)ごとに配る。途中からつないだ人もすぐ映せるよう、最後のキーフレーム以降を取っておく

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, watch};

use crate::monitor::WindowInfo;
use crate::session::SCREEN;

/// 1秒あたりのフレーム数の上限(3.3 の L4)
pub const FPS: u32 = 60;
/// キーフレームの間隔(2秒。9.1)
const GOP: u32 = FPS * 2;

/// H.264 の1フレーム(Annex B 形式。先頭に AUD が付く)
#[derive(Debug)]
pub struct Frame {
    pub key: bool,
    /// 受け取った時刻(UNIX エポックからのマイクロ秒)。ブラウザの復号器のタイムスタンプに使う
    pub timestamp_us: u64,
    pub data: Bytes,
}

pub struct Stream {
    tx: broadcast::Sender<Arc<Frame>>,
    state: Mutex<State>,
    /// ffmpeg が終わった(止めた・落ちた)。大きさの変化で作り直したとき、見ている側が新しい映像へ移るのに使う
    ended: watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    /// WebCodecs に渡すコーデック名(例 avc1.42C01F)。最初の SPS から決まる
    codec: Option<String>,
    /// 最後のキーフレームから今までのフレーム
    gop: Vec<Arc<Frame>>,
    child: Option<Child>,
}

impl Stream {
    /// `display` の `window` の取り込みを始める。ウィンドウそのもの(`-window_id`)ではなく画面上のその範囲を取り込む。
    /// `-window_id` では、上に重なった一時的な窓(メニュー・ツールチップ)の部分が黒く抜けるため(7.9、ADR 0012)
    pub fn start(display: u32, window: &WindowInfo) -> anyhow::Result<Arc<Self>> {
        // 画面からはみ出す部分は取り込めない(x11grab が失敗する)
        let (x, y) = (window.x.max(0), window.y.max(0));
        let width = window.width.min(SCREEN.0.saturating_sub(x as u32)).max(2);
        let height = window.height.min(SCREEN.1.saturating_sub(y as u32)).max(2);
        let (tx, _) = broadcast::channel(256);
        let stream = Arc::new(Self {
            tx,
            state: Mutex::new(State::default()),
            ended: watch::channel(false).0,
        });
        let mut child = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(["-fflags", "nobuffer", "-f", "x11grab", "-draw_mouse", "0"])
            .args([
                "-framerate",
                &FPS.to_string(),
                "-video_size",
                &format!("{width}x{height}"),
                "-grab_x",
                &x.to_string(),
                "-grab_y",
                &y.to_string(),
                "-i",
                &format!(":{display}"),
            ])
            // H.264 は幅と高さが偶数でないといけない
            .args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-pix_fmt",
                "yuv420p",
            ])
            .args(["-g", &GOP.to_string(), "-bf", "0"])
            // フレームの区切りが分かるよう、各フレームの先頭に AUD を入れる
            .args([
                "-bsf:v",
                "h264_metadata=aud=insert",
                "-flush_packets",
                "1",
                "-f",
                "h264",
                "-",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        stream.state.lock().unwrap().child = Some(child);
        tokio::spawn(read_frames(Arc::downgrade(&stream), stdout));
        let id = window.id;
        tokio::spawn(async move {
            let mut s = String::new();
            let mut err = stderr;
            let _ = err.read_to_string(&mut s).await;
            if !s.trim().is_empty() {
                tracing::warn!(window = id, "ffmpeg(ライブ描画): {}", s.trim());
            }
        });
        Ok(stream)
    }

    /// これまでのフレーム(最後のキーフレーム以降)と、これからのフレームの受け口
    pub fn subscribe(
        &self,
    ) -> (
        Option<String>,
        Vec<Arc<Frame>>,
        broadcast::Receiver<Arc<Frame>>,
    ) {
        let st = self.state.lock().unwrap();
        (st.codec.clone(), st.gop.clone(), self.tx.subscribe())
    }

    pub fn stop(&self) {
        if let Some(mut c) = self.state.lock().unwrap().child.take() {
            let _ = c.start_kill();
        }
        self.ended.send_replace(true);
    }

    /// 映像が終わるまで待つ
    pub async fn ended(&self) {
        let mut rx = self.ended.subscribe();
        let _ = rx.wait_for(|e| *e).await;
    }

    fn push(&self, frame: Frame) {
        let frame = Arc::new(frame);
        let mut st = self.state.lock().unwrap();
        if frame.key {
            if st.codec.is_none() {
                st.codec = codec_of(&frame.data);
            }
            st.gop.clear();
        }
        st.gop.push(frame.clone());
        drop(st);
        let _ = self.tx.send(frame);
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop();
    }
}

/// ffmpeg の出力を AUD ごとに区切ってフレームにする
async fn read_frames(stream: std::sync::Weak<Stream>, mut out: tokio::process::ChildStdout) {
    let mut buf = BytesMut::with_capacity(1 << 20);
    loop {
        match out.read_buf(&mut buf).await {
            Ok(0) | Err(_) => {
                if let Some(s) = stream.upgrade() {
                    s.ended.send_replace(true);
                }
                return;
            }
            Ok(_) => {}
        }
        // 2つ目の AUD が来たら、そこまでが1フレーム
        while let Some(end) = find_aud(&buf, 1) {
            let data = buf.split_to(end).freeze();
            let Some(s) = stream.upgrade() else { return };
            s.push(Frame {
                key: has_nal(&data, 5),
                timestamp_us: now_us(),
                data,
            });
        }
    }
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

/// NAL ユニットの開始位置(開始コードの位置)と NAL の種類を順に返す
fn nals(data: &[u8]) -> impl Iterator<Item = (usize, u8)> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        while i + 3 < data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
                let start = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
                let kind = data[i + 3] & 0x1f;
                i += 3;
                return Some((start, kind));
            }
            i += 1;
        }
        None
    })
}

/// 先頭から数えて `skip` 個目より後の AUD(NAL 種類 9)の位置
fn find_aud(data: &[u8], skip: usize) -> Option<usize> {
    nals(data)
        .filter(|&(_, k)| k == 9)
        .nth(skip)
        .map(|(p, _)| p)
}

fn has_nal(data: &[u8], kind: u8) -> bool {
    nals(data).any(|(_, k)| k == kind)
}

/// SPS から WebCodecs のコーデック名(avc1.PPCCLL)を作る
fn codec_of(data: &[u8]) -> Option<String> {
    let (pos, _) = nals(data).find(|&(_, k)| k == 7)?;
    let start = pos + if data[pos + 2] == 1 { 3 } else { 4 };
    let sps = data.get(start + 1..start + 4)?;
    Some(format!("avc1.{:02X}{:02X}{:02X}", sps[0], sps[1], sps[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_reads_codec() {
        // AUD, SPS(profile 0x64, flags 0x00, level 0x1f), IDR, AUD, P
        let data = [
            0, 0, 0, 1, 0x09, 0xf0, //
            0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, //
            0, 0, 1, 0x65, 0x88, //
            0, 0, 0, 1, 0x09, 0xf0, //
            0, 0, 1, 0x41, 0x9a,
        ];
        let end = find_aud(&data, 1).unwrap();
        assert_eq!(end, 20);
        assert!(has_nal(&data[..end], 5));
        assert!(!has_nal(&data[end..], 5));
        assert_eq!(codec_of(&data[..end]).as_deref(), Some("avc1.64001F"));
    }
}
