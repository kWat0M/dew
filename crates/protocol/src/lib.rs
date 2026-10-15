//! ブラウザとサーバの間でやり取りする型。ts-rs で web/src/protocol/ に TypeScript として出力する
//! (`cargo nextest run` で更新される。TS 側の型は手で書かない)

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `GET /api/info` の応答
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Info {
    /// 閲覧範囲の起点
    pub root: String,
    /// Home の初期位置
    pub home: String,
}

/// `GET /api/tree?path=` の応答
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Tree {
    /// 正規化した絶対パス
    pub path: String,
    /// 親ディレクトリ。閲覧範囲の起点では None
    pub parent: Option<String>,
    /// ディレクトリが先、名前順
    pub entries: Vec<Entry>,
}

/// ディレクトリ内の1項目(シンボリックリンクはたどった先の情報)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub media: MediaKind,
    #[ts(type = "number")]
    pub size: u64,
    /// 更新時刻(UNIX エポックからのミリ秒)
    pub mtime: f64,
    /// 読めないファイルは鍵アイコンで表示する(7.2)
    pub readable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum EntryKind {
    Dir,
    File,
}

/// 拡張子から判断した種別
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    Other,
}

/// `GET /api/probe?path=` の応答
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Probe {
    /// 秒
    pub duration: f64,
    /// 平均フレームレート
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    /// ブラウザで再生できないため変換が必要か(2.6)
    pub needs_transcode: bool,
    /// 変換するときのセグメントの長さ(秒)と個数
    pub segment_secs: f64,
    pub segment_count: u32,
    /// 各フレームの表示時刻(秒)。可変フレームレートでも番号がずれないように使う(7.5)
    pub frame_times: Vec<f64>,
}

/// `POST /api/open` の要求(F10)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenRequest {
    pub path: String,
}

/// `POST /api/open` の応答
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenResponse {
    /// 接続中のタブに届けたか。false なら CLI は URL を表示する(8.2)
    pub delivered: bool,
}

/// `WS /ws/events` でサーバから送る通知
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ServerEvent {
    /// ディレクトリの中身が変わった(F4)
    DirChanged { dir: String, name: String },
    /// CLI からの表示指示(F10)
    Open { path: String },
}

/// `WS /ws/events` でブラウザから送る通知
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ClientEvent {
    /// 表示中のディレクトリ。変更通知はこれらについてだけ送る
    Watch { dirs: Vec<String> },
    /// ユーザーがこのタブを操作した。表示指示は最後に操作したタブに送る(7.7)
    Active,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_tagged_in_camel_case() {
        let ev = ServerEvent::DirChanged {
            dir: "/a".into(),
            name: "b".into(),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"type":"dirChanged","dir":"/a","name":"b"}"#
        );
        let ev: ClientEvent = serde_json::from_str(r#"{"type":"active"}"#).unwrap();
        assert!(matches!(ev, ClientEvent::Active));
    }
}
