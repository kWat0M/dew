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
    /// Markdown(ドキュメントウィンドウで開く。15.1)
    Markdown,
    /// CSV / TSV(ドキュメントウィンドウで開く。15.1、16章)
    Csv,
    Other,
}

/// 文書の文字コード(15.8)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TextEncoding {
    Utf8,
    Utf16le,
    Utf16be,
    ShiftJis,
    EucJp,
}

/// `GET /api/text?path=&encoding=` の応答: UTF-8 にした文書(15.8、17.1)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TextDoc {
    pub text: String,
    /// 変換に使った文字コード(指定があればそれ)
    pub encoding: TextEncoding,
    /// 判定した文字コード
    pub detected: TextEncoding,
    /// 大きすぎる(5 MB 超)ので、描画せずにプレーンテキストで出す(17.5)
    pub large: bool,
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
    /// 足りないために、分からないこと・できないことがあるツール(ffprobe がなければ長さやフレームの時刻が
    /// 分からない、ffmpeg がなければプレビューや変換ができない)。画面はそれを知らせる
    #[serde(default)]
    pub missing: Vec<String>,
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
    /// 精度モード(L3)のフックがつなぐソケット(`dew run --exact` が DEW_EXACT_SOCKET で渡す)
    pub exact_socket: String,
    /// 音を映せるか(pulseaudio がなければ false で、映像だけを映す)
    pub audio: bool,
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

/// `POST /api/shell` の要求: `dew activate` / `deactivate` したシェルの登録と取り消し(13.6)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellRequest {
    /// シェル本体の PID(`--shell-pid $$`)
    pub pid: u32,
    /// true で登録、false で取り消し
    pub active: bool,
}

/// `GET /api/shells` の応答
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellCount {
    /// activate 中のシェルの数
    pub count: u32,
}

/// `POST /api/rotate-token` の応答(14.6)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RotateTokenResponse {
    pub token: String,
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
    /// CSV を大規模モードのデータベースに読み込んでいる(16.5)。終わったら finished、失敗したら error
    CsvProgress {
        path: String,
        #[ts(type = "number")]
        done: u64,
        #[ts(type = "number")]
        total: u64,
        finished: bool,
        error: Option<String>,
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
    /// 録画中(L7)
    pub recording: bool,
    /// 精度モード(L3)の cv2.imshow の窓。映像は H.264 ではなく PNG(`LiveConfig.codec` が "png")
    pub exact: bool,
}

/// `POST /api/live/record`: ライブウィンドウの録画を始める(`on: true`)・止める(L7)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordRequest {
    pub window: u32,
    pub on: bool,
}

/// `POST /api/live/record` の応答。止めたときは保存したファイル(閲覧範囲の起点からの相対パス)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordResult {
    pub path: Option<String>,
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
    /// キーを押して離す。キーの行き先の切り替えから離すまでを1回で行う(複数のウィンドウへ同じキーを送るとき、
    /// ウィンドウごとの送信が混ざって別のウィンドウに届かないように。ADR 0030)
    Tap {
        key: String,
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
    /// キャンバスでウィンドウを閉じた。デスクトップの × と同じく、アプリに閉じるよう頼む(7.9)
    Close,
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

// ---- CSV(16章) ----

/// 小規模モード(ブラウザで全件を持つ)と大規模モード(サーバの DuckDB に問い合わせる)。16.1
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CsvMode {
    Small,
    Large,
}

/// 列の型(16.2)。日付は日付と日時の両方(ISO 8601 の文字列のまま比べる)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CsvType {
    Integer,
    Float,
    Boolean,
    Date,
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvColumn {
    pub name: String,
    pub ty: CsvType,
    /// 数値の列の、小数の桁数の最大(丸めの「そのまま」の桁数)
    pub decimals: u8,
}

/// 文字コード・区切り文字・ヘッダーの手動設定(なければ判定した値を使う。16.2)
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub encoding: Option<TextEncoding>,
    /// 1文字(タブは "\t")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub delimiter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub header: Option<bool>,
}

/// `GET /api/csv/schema?path=&encoding=&delimiter=&header=` の応答
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvSchema {
    pub mode: CsvMode,
    pub columns: Vec<CsvColumn>,
    pub encoding: TextEncoding,
    pub detected: TextEncoding,
    pub delimiter: String,
    pub header: bool,
    /// データの行数
    #[ts(type = "number")]
    pub rows: u64,
    /// 列数が不揃いな行の数
    #[ts(type = "number")]
    pub ragged: u64,
    /// 大規模モードで、データベースへの読み込みが済んでいる(済むまでは CsvProgress を送る)
    pub ready: bool,
}

/// `GET /api/csv/rows`: 小規模モードの全行。列ごとの値(空のセルは null)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvRows {
    pub columns: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvSort {
    pub col: u32,
    pub desc: bool,
}

/// フィルターの条件(16.4)。文字列: contains〜notEmpty、数値・日付: eq〜between と empty / notEmpty、真偽値: true / false / empty
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CsvFilterOp {
    Contains,
    Equals,
    StartsWith,
    Empty,
    NotEmpty,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Between,
    True,
    False,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvFilter {
    pub col: u32,
    pub op: CsvFilterOp,
    #[serde(default)]
    pub value: String,
    /// between の上限
    #[serde(default)]
    pub value2: String,
}

/// `POST /api/csv/query`: 大規模モードのページ(16.5)。列は番号で指定する(SQL は受け取らない)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvQuery {
    pub path: String,
    #[serde(default)]
    pub options: CsvOptions,
    #[serde(default)]
    pub sort: Vec<CsvSort>,
    #[serde(default)]
    pub filters: Vec<CsvFilter>,
    #[ts(type = "number")]
    pub offset: u64,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvPage {
    /// 行ごとの値
    pub rows: Vec<Vec<Option<String>>>,
    /// 元の行番号(1 から)
    #[ts(type = "number[]")]
    pub row_numbers: Vec<u64>,
    /// フィルター後の行数
    #[ts(type = "number")]
    pub total: u64,
}

/// `POST /api/csv/search`: 大規模モードの検索。並べ替え・フィルター後の位置と列(16.4)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvSearch {
    pub path: String,
    #[serde(default)]
    pub options: CsvOptions,
    #[serde(default)]
    pub sort: Vec<CsvSort>,
    #[serde(default)]
    pub filters: Vec<CsvFilter>,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvMatches {
    /// [位置, 列] の並び(上から、左から)
    #[ts(type = "[number, number][]")]
    pub matches: Vec<(u64, u32)>,
    /// 多すぎるので途中までにした
    pub truncated: bool,
}

/// `GET /api/csv/preview?path=`: Home のプレビュー(先頭20行・最大10列。15.5)。ファイルの先頭だけを読む
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub encoding: TextEncoding,
    pub delimiter: String,
}

/// 条件付き強調の色(MD3 の container 系。16.3)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CsvColor {
    Primary,
    Secondary,
    Tertiary,
    Error,
}

/// 条件付き強調のルール。条件はフィルターと同じ
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvRule {
    pub col: u32,
    pub op: CsvFilterOp,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub value2: String,
    pub color: CsvColor,
}

/// 列ごとの表示だけの設定(元のデータは変えない。16.3)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CsvColumnView {
    pub col: u32,
    /// 表示名
    #[ts(optional)]
    pub label: Option<String>,
    /// 小数の桁数(なければ「そのまま」)
    #[ts(optional)]
    pub decimals: Option<u8>,
    /// 桁区切り
    pub grouping: bool,
    pub hidden: bool,
    /// 左に固定
    pub pinned: bool,
    /// 列幅(px)
    #[ts(optional)]
    pub width: Option<f64>,
}

/// `GET / PUT /api/csv/view?path=`: 表示設定(16.6)。サーバのメモリにファイルごとに置き、dew stop で消える
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CsvView {
    pub options: CsvOptions,
    pub sort: Vec<CsvSort>,
    pub filters: Vec<CsvFilter>,
    pub search: String,
    /// 既定から変えた列だけ
    pub columns: Vec<CsvColumnView>,
    /// マークした行(元の行番号)
    #[ts(type = "number[]")]
    pub marks: Vec<u64>,
    pub rules: Vec<CsvRule>,
    /// 選択中のセル(並べ替え・フィルター後の位置と、列番号)
    #[ts(type = "[number, number]")]
    pub cell: (u64, u32),
    /// スクロール位置(上、左)
    pub scroll: (f64, f64),
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
