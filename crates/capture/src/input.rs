//! 入力モードのキー・マウスを、XTest でアプリへ注入する(L6、5.5、5.6)。
//! キーはブラウザの KeyboardEvent.key から X11 の keysym にし、押した文字どおりに届ける
//! (仮想ディスプレイのキー配列にない文字は、空いているキーコードに一時的に割り当てる)

use std::collections::HashMap;

use anyhow::Context;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt, InputFocus, KEY_PRESS_EVENT,
    KEY_RELEASE_EVENT, Keycode, Keysym, MOTION_NOTIFY_EVENT, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

const SHIFT_L: Keysym = 0xffe1;

pub struct Injector {
    conn: RustConnection,
    root: Window,
    min_keycode: Keycode,
    max_keycode: Keycode,
    /// keysym → (キーコード, Shift が要るか)
    map: HashMap<Keysym, (Keycode, bool)>,
    /// 割り当てに使える、どの keysym も持たないキーコード
    spare: Vec<Keycode>,
    /// 押しているキー(離すときに同じキーコードを使う)
    down: HashMap<Keysym, (Keycode, bool)>,
}

impl Injector {
    pub fn new(display: u32) -> anyhow::Result<Self> {
        let (conn, screen) = crate::monitor::connect(display)?;
        let root = conn.setup().roots[screen].root;
        let (min_keycode, max_keycode) = (conn.setup().min_keycode, conn.setup().max_keycode);
        let mut inj = Self {
            conn,
            root,
            min_keycode,
            max_keycode,
            map: HashMap::new(),
            spare: Vec::new(),
            down: HashMap::new(),
        };
        inj.load_mapping()?;
        Ok(inj)
    }

    fn load_mapping(&mut self) -> anyhow::Result<()> {
        let count = self.max_keycode - self.min_keycode + 1;
        let reply = self
            .conn
            .get_keyboard_mapping(self.min_keycode, count)?
            .reply()?;
        let per = reply.keysyms_per_keycode as usize;
        self.map.clear();
        self.spare.clear();
        for (i, syms) in reply.keysyms.chunks(per).enumerate() {
            let code = self.min_keycode + i as u8;
            if syms.iter().all(|&s| s == 0) {
                self.spare.push(code);
                continue;
            }
            // 1段目(Shift なし)を優先し、なければ2段目(Shift あり)
            for (level, &sym) in syms.iter().take(2).enumerate() {
                if sym != 0 {
                    self.map.entry(sym).or_insert((code, level == 1));
                }
            }
        }
        Ok(())
    }

    /// keysym を押せるキーコード。配列になければ空いているキーコードに割り当てる
    fn keycode_for(&mut self, sym: Keysym) -> anyhow::Result<(Keycode, bool)> {
        if let Some(&k) = self.map.get(&sym) {
            return Ok(k);
        }
        // 空きがなければ、最後に使ったものを使い回す
        let code = match self.spare.pop() {
            Some(c) => c,
            None => self.max_keycode,
        };
        self.conn
            .change_keyboard_mapping(1, code, 1, &[sym])?
            .check()
            .context("キー配列を変えられません")?;
        self.map.insert(sym, (code, false));
        Ok((code, false))
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> anyhow::Result<()> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)?;
        Ok(())
    }

    /// キーを押す / 離す。`key` はブラウザの KeyboardEvent.key
    pub fn key(&mut self, window: Window, key: &str, down: bool) -> anyhow::Result<()> {
        let Some(sym) = keysym(key) else {
            return Ok(());
        };
        if down {
            self.focus(window)?;
            let (code, shift) = self.keycode_for(sym)?;
            let shift_code = if shift {
                Some(self.keycode_for(SHIFT_L)?.0)
            } else {
                None
            };
            if let Some(s) = shift_code {
                self.fake(KEY_PRESS_EVENT, s, 0, 0)?;
            }
            self.fake(KEY_PRESS_EVENT, code, 0, 0)?;
            if let Some(s) = shift_code {
                self.fake(KEY_RELEASE_EVENT, s, 0, 0)?;
            }
            self.down.insert(sym, (code, shift));
        } else if let Some((code, _)) = self.down.remove(&sym) {
            self.fake(KEY_RELEASE_EVENT, code, 0, 0)?;
        }
        self.conn.flush()?;
        Ok(())
    }

    /// マウスをウィンドウの中の (x, y) へ動かす
    pub fn motion(&mut self, window: Window, x: i16, y: i16) -> anyhow::Result<()> {
        let (rx, ry) = self.to_root(window, x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, rx, ry)?;
        self.conn.flush()?;
        Ok(())
    }

    /// マウスのボタン(1 左、2 中、3 右、4・5 ホイール)
    pub fn button(
        &mut self,
        window: Window,
        button: u8,
        down: bool,
        x: i16,
        y: i16,
    ) -> anyhow::Result<()> {
        self.focus(window)?;
        self.motion(window, x, y)?;
        self.fake(
            if down {
                BUTTON_PRESS_EVENT
            } else {
                BUTTON_RELEASE_EVENT
            },
            button,
            0,
            0,
        )?;
        self.conn.flush()?;
        Ok(())
    }

    /// 入力モードを抜けるとき、押したままのキーを離す(押しっぱなしにならないように)
    pub fn release_all(&mut self) -> anyhow::Result<()> {
        for (_, (code, _)) in self.down.drain() {
            self.conn
                .xtest_fake_input(KEY_RELEASE_EVENT, code, 0, self.root, 0, 0, 0)?;
        }
        self.conn.flush()?;
        Ok(())
    }

    /// ウィンドウマネージャがないので、キーの行き先を dew が直接切り替える(7.9)
    fn focus(&self, window: Window) -> anyhow::Result<()> {
        self.conn
            .set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)?;
        Ok(())
    }

    fn to_root(&self, window: Window, x: i16, y: i16) -> anyhow::Result<(i16, i16)> {
        let r = self
            .conn
            .translate_coordinates(window, self.root, x, y)?
            .reply()?;
        Ok((r.dst_x, r.dst_y))
    }
}

/// KeyboardEvent.key を X11 の keysym にする。送らないキーは None
pub fn keysym(key: &str) -> Option<Keysym> {
    let named = match key {
        "Enter" => 0xff0d,
        "Backspace" => 0xff08,
        "Tab" => 0xff09,
        "Escape" => 0xff1b,
        "Delete" => 0xffff,
        "Insert" => 0xff63,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "Shift" => 0xffe1,
        "Control" => 0xffe3,
        "Alt" => 0xffe9,
        "Meta" => 0xffeb,
        "CapsLock" => 0xffe5,
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }
    if let Some(n) = key
        .strip_prefix('F')
        .and_then(|n| n.parse::<u32>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        return Some(0xffbe + n - 1);
    }
    // 1文字: Latin-1 はそのまま、それ以外は Unicode の keysym(0x01000000 + コードポイント)
    let mut chars = key.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    let cp = c as u32;
    Some(
        if (0x20..=0x7e).contains(&cp) || (0xa0..=0xff).contains(&cp) {
            cp
        } else {
            0x0100_0000 + cp
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keysyms_from_keyboard_event_key() {
        assert_eq!(keysym("a"), Some(0x61));
        assert_eq!(keysym("A"), Some(0x41));
        assert_eq!(keysym(" "), Some(0x20));
        assert_eq!(keysym("["), Some(0x5b));
        assert_eq!(keysym("Enter"), Some(0xff0d));
        assert_eq!(keysym("F5"), Some(0xffc2));
        assert_eq!(keysym("あ"), Some(0x0100_3042));
        assert_eq!(keysym("Process"), None);
        assert_eq!(keysym("Unidentified"), None);
    }
}
