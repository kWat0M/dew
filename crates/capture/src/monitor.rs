//! 仮想ディスプレイのウィンドウの監視(6.1 の 2)。アプリが開いたトップレベルのウィンドウを見つけ、
//! 重ならない位置に置き直し、名前・大きさの変化と閉じたことを知らせる。x11rb(純 Rust)で X に話す

use std::collections::HashMap;

use anyhow::Context;
use tokio::sync::mpsc;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt, EventMask, MapState,
    Window,
};
use x11rb::rust_connection::RustConnection;

use crate::session::SCREEN;

/// ウィンドウを並べるときの間隔
const GAP: i32 = 16;

/// ライブ描画のウィンドウ1つ
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub width: u32,
    pub height: u32,
    /// `_NET_WM_PID`(音声をウィンドウに結びつけるのに使う。7.6)
    pub pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum WindowEvent {
    /// 新しく出た、または名前・大きさが変わった
    Changed(WindowInfo),
    /// 閉じた
    Closed(u32),
}

/// `display`(例 100)のウィンドウを監視するスレッドを起動し、変化を `tx` に送る。接続が切れたら終わる
pub fn spawn(display: u32, tx: mpsc::UnboundedSender<WindowEvent>) -> anyhow::Result<()> {
    let (conn, screen) = connect(display)?;
    std::thread::Builder::new()
        .name(format!("dew-x11-{display}"))
        .spawn(move || {
            if let Err(e) = run(conn, screen, tx) {
                tracing::info!("ウィンドウの監視を終えます: {e:#}");
            }
        })?;
    Ok(())
}

/// 仮想ディスプレイにつなぐ。x11rb は /tmp/.X11-unix のソケットしか試さないので、つながらなければ
/// Linux の抽象名前空間のソケットにつなぐ(/tmp/.X11-unix が使えない環境では Xvfb はそこでだけ待ち受ける)
pub fn connect(display: u32) -> anyhow::Result<(RustConnection, usize)> {
    if let Ok(c) = x11rb::connect(Some(&format!(":{display}"))) {
        return Ok(c);
    }
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixStream};
    let addr = SocketAddr::from_abstract_name(format!("/tmp/.X11-unix/X{display}").as_bytes())?;
    let stream = UnixStream::connect_addr(&addr).context("仮想ディスプレイにつなげません")?;
    let (stream, _) = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)?;
    Ok((
        RustConnection::connect_to_stream(stream, 0).context("仮想ディスプレイにつなげません")?,
        0,
    ))
}

fn run(
    conn: RustConnection,
    screen: usize,
    tx: mpsc::UnboundedSender<WindowEvent>,
) -> anyhow::Result<()> {
    let root = conn.setup().roots[screen].root;
    conn.change_window_attributes(
        root,
        &ChangeWindowAttributesAux::new().event_mask(EventMask::SUBSTRUCTURE_NOTIFY),
    )?
    .check()?;
    let atoms = Atoms::new(&conn)?;
    let mut known: HashMap<Window, WindowInfo> = HashMap::new();
    let mut placer = Placer::default();

    // 監視を始める前から出ているウィンドウ
    for w in conn.query_tree(root)?.reply()?.children {
        // 問い合わせの間に消えたウィンドウは飛ばす
        let Ok(attrs) = conn.get_window_attributes(w)?.reply() else {
            continue;
        };
        if !attrs.override_redirect && attrs.map_state == MapState::VIEWABLE {
            try_track(&conn, &atoms, w, &mut known, &mut placer, &tx);
        }
    }
    loop {
        let event = conn.wait_for_event()?;
        match event {
            Event::MapNotify(e) if e.event == root && !e.override_redirect => {
                try_track(&conn, &atoms, e.window, &mut known, &mut placer, &tx);
            }
            Event::ConfigureNotify(e) if e.event == root => {
                if let Some(info) = known.get_mut(&e.window)
                    && (info.width, info.height) != (u32::from(e.width), u32::from(e.height))
                {
                    info.width = e.width.into();
                    info.height = e.height.into();
                    let _ = tx.send(WindowEvent::Changed(info.clone()));
                }
            }
            Event::PropertyNotify(e)
                if e.atom == atoms.net_wm_name || e.atom == u32::from(AtomEnum::WM_NAME) =>
            {
                if let Some(info) = known.get_mut(&e.window) {
                    let title = title_of(&conn, &atoms, e.window).unwrap_or_default();
                    if title != info.title {
                        info.title = title;
                        let _ = tx.send(WindowEvent::Changed(info.clone()));
                    }
                }
            }
            Event::UnmapNotify(e) if e.event == root => {
                close(e.window, &mut known, &mut placer, &tx)
            }
            Event::DestroyNotify(e) if e.event == root => {
                close(e.window, &mut known, &mut placer, &tx)
            }
            _ => {}
        }
        if tx.is_closed() {
            return Ok(());
        }
    }
}

/// `track` の失敗は、そのウィンドウを無視して監視を続ける。アプリは起動時に作ってすぐ消す
/// ウィンドウを出すことがあり(pygame など)、問い合わせる前に消えていると X のエラーになるため
fn try_track(
    conn: &RustConnection,
    atoms: &Atoms,
    w: Window,
    known: &mut HashMap<Window, WindowInfo>,
    placer: &mut Placer,
    tx: &mpsc::UnboundedSender<WindowEvent>,
) {
    if let Err(e) = track(conn, atoms, w, known, placer, tx) {
        tracing::debug!(window = w, "ウィンドウを追えません(すぐ消えたもの): {e:#}");
        placer.free(w);
    }
}

/// 見つけたウィンドウを覚え、重ならない位置に置き直して知らせる
fn track(
    conn: &RustConnection,
    atoms: &Atoms,
    w: Window,
    known: &mut HashMap<Window, WindowInfo>,
    placer: &mut Placer,
    tx: &mpsc::UnboundedSender<WindowEvent>,
) -> anyhow::Result<()> {
    if known.contains_key(&w) {
        return Ok(());
    }
    let geo = conn.get_geometry(w)?.reply()?;
    // 名前の変化を知るため
    conn.change_window_attributes(
        w,
        &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )?;
    // 隠れた部分が欠けないよう、ほかのウィンドウと重ならない位置へ(ADR 0009)
    let (x, y) = placer.place(w, geo.width.into(), geo.height.into());
    conn.configure_window(w, &ConfigureWindowAux::new().x(x).y(y))?;
    conn.flush()?;
    let info = WindowInfo {
        id: w,
        title: title_of(conn, atoms, w).unwrap_or_default(),
        width: geo.width.into(),
        height: geo.height.into(),
        pid: pid_of(conn, atoms, w),
    };
    known.insert(w, info.clone());
    let _ = tx.send(WindowEvent::Changed(info));
    Ok(())
}

fn close(
    w: Window,
    known: &mut HashMap<Window, WindowInfo>,
    placer: &mut Placer,
    tx: &mpsc::UnboundedSender<WindowEvent>,
) {
    if known.remove(&w).is_some() {
        placer.free(w);
        let _ = tx.send(WindowEvent::Closed(w));
    }
}

struct Atoms {
    net_wm_name: u32,
    net_wm_pid: u32,
    utf8_string: u32,
}

impl Atoms {
    fn new(conn: &RustConnection) -> anyhow::Result<Self> {
        let get = |name: &str| -> anyhow::Result<u32> {
            Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
        };
        Ok(Self {
            net_wm_name: get("_NET_WM_NAME")?,
            net_wm_pid: get("_NET_WM_PID")?,
            utf8_string: get("UTF8_STRING")?,
        })
    }
}

/// ウィンドウの名前(_NET_WM_NAME、なければ WM_NAME)
fn title_of(conn: &RustConnection, atoms: &Atoms, w: Window) -> Option<String> {
    let utf8 = conn
        .get_property(false, w, atoms.net_wm_name, atoms.utf8_string, 0, 1024)
        .ok()?
        .reply()
        .ok()?;
    if !utf8.value.is_empty() {
        return Some(String::from_utf8_lossy(&utf8.value).into_owned());
    }
    let name = conn
        .get_property(false, w, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 1024)
        .ok()?
        .reply()
        .ok()?;
    Some(String::from_utf8_lossy(&name.value).into_owned())
}

fn pid_of(conn: &RustConnection, atoms: &Atoms, w: Window) -> Option<u32> {
    let r = conn
        .get_property(false, w, atoms.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    r.value32()?.next()
}

/// 仮想ディスプレイの上で、ウィンドウを重ならないように左上から横に並べる
#[derive(Default)]
struct Placer {
    placed: HashMap<Window, (i32, i32, i32, i32)>,
}

impl Placer {
    fn place(&mut self, w: Window, width: i32, height: i32) -> (i32, i32) {
        let overlaps = |x: i32, y: i32| {
            self.placed.values().any(|&(px, py, pw, ph)| {
                x < px + pw + GAP
                    && px < x + width + GAP
                    && y < py + ph + GAP
                    && py < y + height + GAP
            })
        };
        let (sw, sh) = (SCREEN.0 as i32, SCREEN.1 as i32);
        let mut spot = (0, 0);
        'search: for y in (0..sh.max(1)).step_by(64) {
            for x in (0..sw.max(1)).step_by(64) {
                if x + width <= sw && y + height <= sh && !overlaps(x, y) {
                    spot = (x, y);
                    break 'search;
                }
            }
        }
        self.placed.insert(w, (spot.0, spot.1, width, height));
        spot
    }

    fn free(&mut self, w: Window) {
        self.placed.remove(&w);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placer_avoids_overlap() {
        let mut p = Placer::default();
        let a = p.place(1, 640, 480);
        let b = p.place(2, 640, 480);
        assert_eq!(a, (0, 0));
        assert!(b.0 >= 640 + GAP, "{b:?}");
        p.free(1);
        assert_eq!(p.place(3, 320, 240), (0, 0), "空いた場所を使い直す");
    }
}
