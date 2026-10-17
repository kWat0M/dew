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
    /// ブラウザで再生できないため変換が必要か(2.6)。画像では、そのままでは正確に表示できないか
    /// (TIFF や 8bit を超えるもの。`GET /api/image` の PNG で表示する)
    pub needs_transcode: bool,
    /// 1色あたりのビット数(8 か 16)。16 なら元の値は `GET /api/pixels` で読む
    pub bit_depth: u32,
    /// 変換するときのセグメントの長さ(秒)と個数
    pub segment_secs: f64,
    pub segment_count: u32,
    /// 各フレームの表示時刻(秒)。可変フレームレートでも番号がずれないように使う(7.5)
    pub frame_times: Vec<f64>,
    /// シークバーのプレビュー(`GET /api/sprite?path=`)の並び。映像がなければ None
    pub sprite: Option<Sprite>,
}

/// シークバー用のサムネイル列。`interval` 秒ごとの画像を `cols` 列で左上から並べた1枚の画像
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Sprite {
    pub interval: f64,
    pub count: u32,
    pub cols: u32,
    pub tile_width: u32,
    pub tile_height: u32,
}

/// `GET /api/history` の応答(4.4)。新しい順
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct History {
    /// 閲覧範囲の起点。各項目の `name` はここからの相対パス
    pub root: String,
    pub entries: Vec<Entry>,
}

/// `POST /api/history` の要求。開いたファイルを履歴の先頭に加える
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryAdd {
    pub paths: Vec<String>,
}

/// `POST /api/live/session` の応答: ライブ描画のセッション(仮想ディスプレイと音声サーバ)につなぐ設定(6.1)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveSession {
    /// 例: ":100"
    pub display: String,
    /// アプリに渡す環境変数
    pub env: Vec<(String, String)>,
    /// アプリから消す環境変数
    pub unset: Vec<String>,
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
    /// 監視を登録した(Watch への応答)。ブラウザはこれを受けて一覧を読み直す
    Watching { dirs: Vec<String> },
    /// ライブ描画のウィンドウの一覧(つないだとき、増減・変化したとき。L1、L2)
    LiveWindows { windows: Vec<LiveWindow> },
    /// CLI からの表示指示(F10)。ファイルはキャンバスに開き、ディレクトリは Home で開く
    Open {
        path: String,
        kind: EntryKind,
        media: MediaKind,
    },
}

/// ライブ描画のウィンドウ1つ(アプリが仮想ディスプレイに開いたトップレベルのウィンドウ)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveWindow {
    /// X のウィンドウ ID。`WS /ws/live/{id}` で映像を受け取る
    pub id: u32,
    pub title: String,
    pub width: u32,
    pub height: u32,
    /// そのウィンドウのアプリの音がある(`WS /ws/live-audio/{id}` で受け取る。7.6)
    pub audio: bool,
}

/// `WS /ws/live/{id}` で最初に送る、映像の復号の設定。続けてフレームをバイナリで送る
/// (1バイト目の bit0 がキーフレーム、続く8バイトがタイムスタンプ(µs、ビッグエンディアン)、残りが H.264 Annex B)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveConfig {
    /// WebCodecs のコーデック名(例 avc1.64001F)
    pub codec: String,
    pub width: u32,
    pub height: u32,
}

/// `WS /ws/live-audio` で最初に送る、セッション音声の復号の設定。続けて Opus のパケットをバイナリで送る
/// (先頭8バイトがタイムスタンプ(µs、ビッグエンディアン)、残りが Opus のパケット)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveAudioConfig {
    pub codec: String,
    pub sample_rate: u32,
    pub number_of_channels: u32,
}

/// 入力モード(L6、5.5)で `WS /ws/live/{id}` にブラウザから送る入力。座標はアプリのウィンドウの中の画素
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LiveInput {
    /// キー(`key` は KeyboardEvent.key)
    Key {
        key: String,
        down: bool,
    },
    Move {
        x: i32,
        y: i32,
    },
    /// マウスのボタン(1 左、2 中、3 右、4・5 ホイール)
    Button {
        button: u8,
        down: bool,
        x: i32,
        y: i32,
    },
    /// 入力モードを抜けた。押したままのキーを離す
    Release,
    /// アプリのウィンドウの大きさを変える(w r。ブラウザ側の大きさに合わせる。7.9)
    Resize {
        width: u32,
        height: u32,
    },
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
