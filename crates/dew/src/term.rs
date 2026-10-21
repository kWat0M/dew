//! 端末へのエスケープシーケンス(14.3、14.4)。標準出力ではなく制御端末(/dev/tty)に書く。
//! yazi などから呼ばれて標準出力が捨てられていても、端末に届くようにするため

use std::io::Write;

/// WezTerm のユーザー変数の名前(`dew setup-wezterm` のハンドラがこの名前を見る)
pub const USER_VAR: &str = "dew_open";

/// `dew setup-wezterm` が出す設定(14.3)。開く URL は `/open?` の形に限る
/// (端末に表示した細工ファイルなどから、任意の URL を開かれないようにするため)
pub const WEZTERM_SETUP: &str = r#"WezTerm から Windows の既定のブラウザで dew を開くには、wezterm.lua に次を足してください(任意)。
足すと、ブラウザのタブがないときの `dew <ファイル>` や `dew url --open` で、ブラウザが開きます。

-- dew: 端末からブラウザを開く
wezterm.on('user-var-changed', function(window, pane, name, value)
  if name == 'dew_open' and value:match('^https?://[^/]+/open%?') then
    wezterm.open_with(value)
  end
end)

注意:
- user-var-changed のハンドラは1つしか持てません。すでにある設定では、そのハンドラの中に
  `if name == 'dew_open' ...` の分岐だけを足してください
- tmux の中で使うときは、~/.tmux.conf に set -g allow-passthrough on が要ります(dew doctor で確かめられます)
- ふだんの設定を変えずに試すには、ふだんの wezterm.lua を読み込んで上のハンドラを足すだけのファイルを作り、
  wezterm --config-file <そのファイル> start で別のウィンドウを開きます(閉じれば何も残りません)
"#;

/// WezTerm に `url` を開かせる(ユーザー変数)。WezTerm 以外の対応端末にも出る通知も添える
pub fn open_in_browser(url: &str) -> bool {
    write_tty(&[
        user_var(USER_VAR, url),
        "\x1b]777;notify;dew;ブラウザで開きます\x07".to_owned(),
    ])
}

/// OSC 52 で `text` を端末のクリップボードにコピーする
pub fn copy(text: &str) -> bool {
    write_tty(&[format!("\x1b]52;c;{}\x07", base64(text.as_bytes()))])
}

fn user_var(name: &str, value: &str) -> String {
    format!(
        "\x1b]1337;SetUserVar={name}={}\x07",
        base64(value.as_bytes())
    )
}

/// 制御端末に書く。制御端末がなければ何もせず false
fn write_tty(seqs: &[String]) -> bool {
    let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open("/dev/tty") else {
        return false;
    };
    let tmux = std::env::var_os("TMUX").is_some_and(|v| !v.is_empty());
    let mut out = String::new();
    for s in seqs {
        if tmux {
            out.push_str(&tmux_passthrough(s));
        } else {
            out.push_str(s);
        }
    }
    tty.write_all(out.as_bytes())
        .and_then(|_| tty.flush())
        .is_ok()
}

/// tmux の passthrough で包む(中の ESC は2つにする)。tmux 側に `allow-passthrough on` が要る
fn tmux_passthrough(seq: &str) -> String {
    format!("\x1bPtmux;{}\x1b\\", seq.replace('\x1b', "\x1b\x1b"))
}

/// OSC 8 のハイパーリンク(WezTerm などではクリックで開ける)
pub fn link(url: &str) -> String {
    format!("\x1b]8;;{url}\x1b\\{url}\x1b]8;;\x1b\\")
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from_be_bytes([0, b[0], b[1], b[2]]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// URL のクエリ値にする(英数字と `-_.~/` はそのまま)
pub fn query_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        for (raw, enc) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(raw.as_bytes()), enc);
        }
    }

    #[test]
    fn tmux_doubles_escapes() {
        assert_eq!(
            tmux_passthrough("\x1b]777;x\x07"),
            "\x1bPtmux;\x1b\x1b]777;x\x07\x1b\\"
        );
    }

    #[test]
    fn query_escape_keeps_slashes() {
        assert_eq!(query_escape("/a b/ü.mp4"), "/a%20b/%C3%BC.mp4");
        assert_eq!(query_escape("a&b=c"), "a%26b%3Dc");
    }
}
