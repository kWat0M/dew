//! ライブ描画の音声(L5、7.6): 仮想の出力先(null-sink)に流れたアプリの音を ffmpeg で Opus にして配る。
//! ウィンドウに結びつけられた音はアプリごとの出力先へ移し(ADR 0013)、残りは既定の出力先 `dew` の
//! 「セッション音声」として1本で配る(ADR 0010)

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::broadcast;

/// Opus の1パケットの長さ(ミリ秒)。短いほど遅延が小さい
pub const FRAME_MS: u64 = 10;
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;

/// Opus の1パケット
#[derive(Debug)]
pub struct Packet {
    /// 始まりからの時刻(マイクロ秒)
    pub timestamp_us: u64,
    pub data: Bytes,
}

pub struct Audio {
    tx: broadcast::Sender<Arc<Packet>>,
    child: Mutex<Option<Child>>,
}

impl Audio {
    /// セッション音声の出力先
    pub const SESSION_SINK: &str = "dew";

    /// `pulse_socket` の音声サーバの、仮想の出力先 `sink` の音を取り込み始める
    pub fn start(pulse_socket: &Path, sink: &str) -> anyhow::Result<Arc<Self>> {
        let (tx, _) = broadcast::channel(256);
        let mut child = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-fflags",
                "nobuffer",
            ])
            .args(["-f", "pulse", "-fragment_size", "1920", "-i"])
            .arg(format!("{sink}.monitor"))
            .args([
                "-c:a",
                "libopus",
                "-b:a",
                "128k",
                "-application",
                "lowdelay",
            ])
            .args([
                "-frame_duration",
                &FRAME_MS.to_string(),
                "-ar",
                &SAMPLE_RATE.to_string(),
                "-ac",
                &CHANNELS.to_string(),
            ])
            // Ogg のページをすぐ書き出す(既定の1秒だと、その分だけ遅れる)
            .args([
                "-page_duration",
                &(FRAME_MS * 1000).to_string(),
                "-flush_packets",
                "1",
                "-f",
                "ogg",
                "-",
            ])
            .env("PULSE_SERVER", format!("unix:{}", pulse_socket.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().expect("stdout");
        let audio = Arc::new(Self {
            tx,
            child: Mutex::new(Some(child)),
        });
        tokio::spawn(read_packets(audio.tx.clone(), stdout));
        Ok(audio)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Packet>> {
        self.tx.subscribe()
    }

    pub fn stop(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.start_kill();
        }
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Ogg のページから Opus のパケットを取り出して配る(最初の2つは OpusHead と OpusTags なので飛ばす)
async fn read_packets(tx: broadcast::Sender<Arc<Packet>>, mut out: tokio::process::ChildStdout) {
    let mut buf = BytesMut::with_capacity(1 << 16);
    let mut ogg = OggReader::default();
    let mut n: u64 = 0;
    loop {
        match out.read_buf(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        for packet in ogg.feed(&mut buf) {
            n += 1;
            if n <= 2 {
                continue;
            }
            let _ = tx.send(Arc::new(Packet {
                timestamp_us: (n - 3) * FRAME_MS * 1000,
                data: packet,
            }));
        }
    }
}

/// Ogg のページを読んでパケットに分ける(ページをまたぐパケットもつなぐ)
#[derive(Default)]
struct OggReader {
    partial: Vec<u8>,
}

impl OggReader {
    fn feed(&mut self, buf: &mut BytesMut) -> Vec<Bytes> {
        let mut packets = Vec::new();
        loop {
            if buf.len() < 27 {
                return packets;
            }
            if &buf[..4] != b"OggS" {
                // 同期が外れたら次の OggS まで進む
                match buf.windows(4).position(|w| w == b"OggS") {
                    Some(p) => buf.advance(p),
                    None => {
                        buf.clear();
                        return packets;
                    }
                }
                continue;
            }
            let segments = buf[26] as usize;
            if buf.len() < 27 + segments {
                return packets;
            }
            let lacing: Vec<usize> = buf[27..27 + segments].iter().map(|&b| b as usize).collect();
            let body: usize = lacing.iter().sum();
            if buf.len() < 27 + segments + body {
                return packets;
            }
            buf.advance(27 + segments);
            let data = buf.split_to(body);
            let mut at = 0;
            for len in lacing {
                self.partial.extend_from_slice(&data[at..at + len]);
                at += len;
                // 255 未満の長さでパケットが終わる
                if len < 255 {
                    packets.push(Bytes::from(std::mem::take(&mut self.partial)));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(lacing: &[u8], body: &[u8]) -> Vec<u8> {
        let mut p = b"OggS".to_vec();
        p.extend_from_slice(&[0; 22]);
        p.push(lacing.len() as u8);
        p.extend_from_slice(lacing);
        p.extend_from_slice(body);
        p
    }

    #[test]
    fn splits_pages_into_packets() {
        let mut r = OggReader::default();
        // 1ページ目: 3バイトのパケットと、ページをまたぐパケットの前半 255 バイト
        let mut body = vec![1, 2, 3];
        body.extend(vec![9; 255]);
        let mut data = page(&[3, 255], &body);
        // 2ページ目: 後半 2 バイト
        data.extend(page(&[2], &[7, 7]));
        let mut buf = BytesMut::from(&data[..10]);
        assert!(r.feed(&mut buf).is_empty(), "途中までなら何も出さない");
        buf.extend_from_slice(&data[10..]);
        let packets = r.feed(&mut buf);
        assert_eq!(packets.len(), 2);
        assert_eq!(&packets[0][..], &[1, 2, 3]);
        assert_eq!(packets[1].len(), 257);
    }
}
