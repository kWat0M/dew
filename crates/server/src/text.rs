//! `GET /api/text?path=&encoding=`: 文書(Markdown、のちに CSV)を UTF-8 にして返す(15.8、17.1)。
//! 文字コードは BOM → UTF-8 として正しいか → chardetng の推定、の順に決める

use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use dew_protocol::{TextDoc, TextEncoding};
use encoding_rs::Encoding;

use crate::App;
use crate::files::{ApiError, resolve};

/// これを超える文書は描画せず、プレーンテキストで出す(17.5)
const LARGE: usize = 5 * 1024 * 1024;

#[derive(serde::Deserialize)]
pub(crate) struct TextQuery {
    path: String,
    /// 手で選んだ文字コード(なければ判定した文字コード)
    #[serde(default)]
    encoding: Option<TextEncoding>,
}

pub(crate) async fn text(
    State(app): State<Arc<App>>,
    Query(q): Query<TextQuery>,
) -> Result<Json<TextDoc>, ApiError> {
    let path = resolve(&app.root, &q.path)?;
    if path.is_dir() {
        return Err(ApiError::NotFound(format!("ディレクトリです: {}", q.path)));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| ApiError::NotFound(format!("{} を読めません: {e}", q.path)))?;
    let doc = tokio::task::spawn_blocking(move || {
        let detected = detect(&bytes);
        let encoding = q.encoding.unwrap_or(detected);
        TextDoc {
            text: decode(&bytes, encoding),
            encoding,
            detected,
            large: bytes.len() > LARGE,
        }
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(doc))
}

fn encoding(e: TextEncoding) -> &'static Encoding {
    match e {
        TextEncoding::Utf8 => encoding_rs::UTF_8,
        TextEncoding::Utf16le => encoding_rs::UTF_16LE,
        TextEncoding::Utf16be => encoding_rs::UTF_16BE,
        TextEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
        TextEncoding::EucJp => encoding_rs::EUC_JP,
    }
}

/// 文字コードを判定する
pub(crate) fn detect(bytes: &[u8]) -> TextEncoding {
    if let Some((enc, _)) = Encoding::for_bom(bytes) {
        return if enc == encoding_rs::UTF_16LE {
            TextEncoding::Utf16le
        } else if enc == encoding_rs::UTF_16BE {
            TextEncoding::Utf16be
        } else {
            TextEncoding::Utf8
        };
    }
    if std::str::from_utf8(bytes).is_ok() {
        return TextEncoding::Utf8;
    }
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(bytes, true);
    // 日本語の文書を想定して推定する。日本語の文字コード以外と推定したときも Shift_JIS として読む
    // (手で切り替えられるのは UTF-8 / Shift_JIS / EUC-JP。15.8)
    let guess = det.guess(Some(b"jp"), chardetng::Utf8Detection::Deny);
    if guess == encoding_rs::EUC_JP {
        TextEncoding::EucJp
    } else {
        TextEncoding::ShiftJis
    }
}

/// `e` で UTF-8 にする。その文字コードの BOM があれば取り除く。読めない並びは置き換え文字にする
pub(crate) fn decode(bytes: &[u8], e: TextEncoding) -> String {
    let enc = encoding(e);
    let body = match Encoding::for_bom(bytes) {
        Some((bom, len)) if bom == enc => &bytes[len..],
        _ => bytes,
    };
    enc.decode_without_bom_handling(body).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_japanese_encodings() {
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("これは Shift_JIS の文書です。漢字");
        assert_eq!(detect(&sjis), TextEncoding::ShiftJis);
        assert_eq!(
            decode(&sjis, TextEncoding::ShiftJis),
            "これは Shift_JIS の文書です。漢字"
        );
        let (euc, _, _) = encoding_rs::EUC_JP.encode("これは EUC-JP の文書です。漢字とかな");
        assert_eq!(detect(&euc), TextEncoding::EucJp);
        assert_eq!(detect("ふつうの UTF-8".as_bytes()), TextEncoding::Utf8);
        assert_eq!(detect(b"\xfe\xff\x00a"), TextEncoding::Utf16be);
        assert_eq!(decode(b"\xfe\xff\x00a", TextEncoding::Utf16be), "a");
    }
}
