//! セッションの pulseaudio の操作(ウィンドウごとの音。7.6)。pulseaudio 本体に入っている
//! module-cli-protocol-unix のソケットへ、pacmd と同じ文字のコマンドを送る。pactl(pulseaudio-utils)を
//! 実行時の依存に足さないため(ADR 0013)

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, bail};

/// 応答の終わりの印。知らないコマンドを送ると、そのエラーが最後に返る
const END: &str = "__dew_end__";

/// アプリの音のストリーム(sink input)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SinkInput {
    pub index: u32,
    /// いま流れている出力先の名前
    pub sink: String,
    /// 音を出しているプロセス(`application.process.id`)
    pub pid: Option<u32>,
}

pub struct Cli {
    path: PathBuf,
}

impl Cli {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// コマンドを送って、応答の文字列を返す
    fn run(&self, cmd: &str) -> anyhow::Result<String> {
        let mut s = UnixStream::connect(&self.path)
            .with_context(|| format!("{} につなげません", self.path.display()))?;
        s.set_read_timeout(Some(Duration::from_secs(2)))?;
        write!(s, "{cmd}\n{END}\n")?;
        let mark = format!("Unknown command: {END}");
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = s.read(&mut buf).context("pulseaudio の応答を読めません")?;
            if n == 0 {
                bail!("pulseaudio の応答が途中で切れました");
            }
            out.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&out);
            if let Some(i) = text.find(&mark) {
                return Ok(text[..i].to_owned());
            }
        }
    }

    pub fn sink_inputs(&self) -> anyhow::Result<Vec<SinkInput>> {
        Ok(parse_sink_inputs(&self.run("list-sink-inputs")?))
    }

    /// 音の出ない出力先 `name` を作る
    pub fn add_sink(&self, name: &str) -> anyhow::Result<()> {
        self.run(&format!(
            "load-module module-null-sink sink_name={name} sink_properties=device.description={name}"
        ))?;
        if sink_module(&self.run("list-sinks")?, name).is_none() {
            bail!("出力先 {name} を作れません");
        }
        Ok(())
    }

    /// 出力先 `name` を消す。流れていた音は既定の出力先(セッション音声)へ戻る
    pub fn remove_sink(&self, name: &str) -> anyhow::Result<()> {
        if let Some(module) = sink_module(&self.run("list-sinks")?, name) {
            self.run(&format!("unload-module {module}"))?;
        }
        Ok(())
    }

    pub fn move_input(&self, index: u32, sink: &str) -> anyhow::Result<()> {
        let out = self.run(&format!("move-sink-input {index} {sink}"))?;
        if !out.trim().is_empty() {
            bail!(
                "音のストリーム {index} を {sink} へ移せません: {}",
                out.trim()
            );
        }
        Ok(())
    }
}

/// `list-sink-inputs` の出力を読む
fn parse_sink_inputs(text: &str) -> Vec<SinkInput> {
    let mut out: Vec<SinkInput> = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("index: ") {
            if let Ok(index) = v.parse() {
                out.push(SinkInput {
                    index,
                    sink: String::new(),
                    pid: None,
                });
            }
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        if let Some(v) = line.strip_prefix("sink: ") {
            // 例: sink: 0 <dew>
            if let Some((_, name)) = v.split_once('<') {
                cur.sink = name.trim_end_matches('>').to_owned();
            }
        } else if let Some(v) = line.strip_prefix("application.process.id = ") {
            cur.pid = v.trim_matches('"').parse().ok();
        }
    }
    out
}

/// `list-sinks` の出力から、出力先 `name` を作ったモジュールの番号を探す
fn sink_module(text: &str, name: &str) -> Option<u32> {
    let want = format!("name: <{name}>");
    let mut found = false;
    for line in text.lines().map(str::trim) {
        if line.contains("index: ") {
            found = false;
        } else if line == want {
            found = true;
        } else if found && let Some(v) = line.strip_prefix("module: ") {
            return v.parse().ok();
        }
    }
    None
}

/// `pid` が `ancestor` そのものか、その子孫のプロセスか(音を別のプロセスで出すアプリのため)
pub fn descends(pid: u32, ancestor: u32) -> bool {
    let mut p = pid;
    for _ in 0..32 {
        if p == ancestor {
            return true;
        }
        match parent_of(p) {
            Some(pp) if pp > 1 => p = pp,
            _ => return false,
        }
    }
    false
}

fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // 2つ目の欄(プロセス名)は空白や括弧を含みうるので、最後の ')' の後ろから読む
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const INPUTS: &str = "2 sink input(s) available.
    index: 0
\tdriver: <protocol-native.c>
\tsink: 0 <dew>
\tproperties:
\t\tapplication.name = \"python3.13\"
\t\tapplication.process.id = \"489138\"
    index: 3
\tsink: 2 <dew_p77>
\tproperties:
\t\tmedia.name = \"x\"
";

    #[test]
    fn reads_sink_inputs() {
        assert_eq!(
            parse_sink_inputs(INPUTS),
            vec![
                SinkInput {
                    index: 0,
                    sink: "dew".into(),
                    pid: Some(489138)
                },
                SinkInput {
                    index: 3,
                    sink: "dew_p77".into(),
                    pid: None
                },
            ]
        );
    }

    #[test]
    fn finds_module_of_sink() {
        let sinks = "2 sink(s) available.
  * index: 0
\tname: <dew>
\tmodule: 1
    index: 1
\tname: <dew_p1>
\tmodule: 3
";
        assert_eq!(sink_module(sinks, "dew_p1"), Some(3));
        assert_eq!(sink_module(sinks, "dew"), Some(1));
        assert_eq!(sink_module(sinks, "nope"), None);
    }

    #[test]
    fn own_process_descends_from_itself_and_parent() {
        let me = std::process::id();
        assert!(descends(me, me));
        assert!(descends(me, parent_of(me).unwrap()));
        assert!(!descends(parent_of(me).unwrap(), me));
    }
}
