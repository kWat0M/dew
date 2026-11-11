//! `dew config`: 設定ファイル(~/.config/dew/config.toml)の URL のホストとポートを、git config の形で読み書きする(ADR 0035)。
//! 書き換えは一番上の段の `host = …` / `port = …` の行だけを置き換え、コメントやほかの設定はそのまま残す

use std::path::Path;
use std::process::{Command, ExitCode};

use anyhow::{Context, bail};
use clap::{Args, ValueEnum};

use crate::config::{self, Origin};

pub const HELP: &str = "\
URL のホストとポートの設定を読み書きする(git config の形)。

  dew config host                  今の値を出す(未設定なら何も出さず、終了コード 1)
  dew config host 192.168.1.10     設定する
  dew config --unset host          消す(設定がなければ終了コード 5)
  dew config --list                設定の一覧(key=value)
  dew config --show-origin host    値がどこで決まったかも出す
  dew config --edit                設定ファイルをエディタで開く

設定は ~/.config/dew/config.toml に書く。環境変数 DEW_PUBLIC_HOST / DEW_PUBLIC_PORT があれば、そちらが優先。
空の環境変数(DEW_PUBLIC_HOST= dew)は「未設定」として、設定ファイルも見ない。
動いているサーバには効かないので、変えたら dew stop してから起動し直す。
port は Docker でポートの番号を付け替えるとき用(サーバに直接入れた dew では設定しない)。";

#[derive(Args)]
pub struct ConfigArgs {
    /// 設定の名前
    #[arg(value_enum)]
    key: Option<Key>,
    /// 新しい値。なければ今の値を出す
    value: Option<String>,
    /// 設定を消す
    #[arg(long, requires = "key", conflicts_with_all = ["value", "list", "edit"])]
    unset: bool,
    /// 設定の一覧を出す(環境変数で上書きしているものは後ろに出す。後のものが効く)
    #[arg(short, long, conflicts_with_all = ["key", "edit"])]
    list: bool,
    /// 設定ファイルをエディタで開く($VISUAL、$EDITOR、vi の順)
    #[arg(short, long, conflicts_with = "key")]
    edit: bool,
    /// 値がどこで決まったか(file:<パス> か env:<環境変数>)をタブ区切りで前に付ける
    #[arg(long, conflicts_with_all = ["value", "edit"])]
    show_origin: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum Key {
    /// URL のホスト(DEW_PUBLIC_HOST)
    Host,
    /// URL のポート(DEW_PUBLIC_PORT)
    Port,
}

impl Key {
    const ALL: [Key; 2] = [Key::Host, Key::Port];

    fn name(self) -> &'static str {
        match self {
            Key::Host => "host",
            Key::Port => "port",
        }
    }

    fn env(self) -> &'static str {
        match self {
            Key::Host => "DEW_PUBLIC_HOST",
            Key::Port => "DEW_PUBLIC_PORT",
        }
    }

    /// 書き込む TOML の値。ホストは引用符の中で逃がしが要らない文字だけにする
    fn literal(self, value: &str) -> anyhow::Result<String> {
        match self {
            Key::Host => {
                if value.is_empty() {
                    bail!("空にはできません。設定を消すには dew config --unset host");
                }
                if !value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-_:[]%".contains(c))
                {
                    bail!(
                        "ホストには、名前か IP アドレスだけを書いてください(例: 192.168.1.10。https:// やポートは付けない)"
                    );
                }
                Ok(format!("\"{value}\""))
            }
            Key::Port => match value.parse::<u16>() {
                Ok(p) if p > 0 => Ok(p.to_string()),
                _ => bail!("ポートは 1〜65535 の数で書いてください"),
            },
        }
    }
}

/// 終了コードは git config に合わせる(値がない 1、消す設定がない 5)
pub fn run(args: &ConfigArgs) -> ExitCode {
    match run_inner(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("dew: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run_inner(args: &ConfigArgs) -> anyhow::Result<ExitCode> {
    if args.edit {
        return edit();
    }
    if args.list {
        list(args.show_origin)?;
        return Ok(ExitCode::SUCCESS);
    }
    let Some(key) = args.key else {
        bail!("設定の名前(host か port)を指定してください。一覧は dew config --list");
    };
    if args.unset {
        if !write(key, None)? {
            eprintln!("dew: {} は設定されていません", key.name());
            return Ok(ExitCode::from(5));
        }
        note_env(key);
        crate::note_running_server();
        return Ok(ExitCode::SUCCESS);
    }
    match &args.value {
        Some(v) => {
            write(key, Some(&key.literal(v)?))?;
            note_env(key);
            crate::note_running_server();
            Ok(ExitCode::SUCCESS)
        }
        None => {
            let file = config::read_table()?.get(key.name()).map(value_text);
            match config::public_value(key.env(), file) {
                (Some(v), origin) => {
                    println!("{}{v}", origin_prefix(args.show_origin, origin, key));
                    Ok(ExitCode::SUCCESS)
                }
                (None, _) => Ok(ExitCode::from(1)),
            }
        }
    }
}

/// 環境変数があると、このシェルでは設定ファイルの値を使わないことを知らせる
fn note_env(key: Key) {
    if let Ok(v) = std::env::var(key.env()) {
        eprintln!(
            "dew: 注意: このシェルでは環境変数 {}(={v})が優先されるので、この設定は使われません",
            key.env()
        );
    }
}

fn origin_prefix(show: bool, origin: Option<Origin>, key: Key) -> String {
    match (show, origin) {
        (false, _) | (true, None) => String::new(),
        (true, Some(Origin::Env)) => format!("env:{}\t", key.env()),
        (true, Some(Origin::File)) => format!("file:{}\t", config::path().display()),
    }
}

/// 設定ファイルの中身(名前の順)、続けて設定ファイルを上書きしている環境変数を `key=value` で出す
fn list(show_origin: bool) -> anyhow::Result<()> {
    let mut entries = Vec::new();
    flatten("", &config::read_table()?, &mut entries);
    for (k, v) in entries {
        println!(
            "{}{k}={v}",
            origin_prefix(show_origin, Some(Origin::File), Key::Host)
        );
    }
    for key in Key::ALL {
        if let Ok(v) = std::env::var(key.env()) {
            println!(
                "{}{}={v}",
                origin_prefix(show_origin, Some(Origin::Env), key),
                key.name()
            );
        }
    }
    Ok(())
}

/// 表を `a.b=値` の形に並べる
fn flatten(prefix: &str, table: &toml::Table, out: &mut Vec<(String, String)>) {
    for (k, v) in table {
        let name = format!("{prefix}{k}");
        match v {
            toml::Value::Table(t) => flatten(&format!("{name}."), t, out),
            v => out.push((name, value_text(v))),
        }
    }
}

/// 値の表示。文字列は引用符を付けずにそのまま(git config と同じ)
fn value_text(v: &toml::Value) -> String {
    match v {
        toml::Value::String(s) => s.clone(),
        toml::Value::Integer(i) => i.to_string(),
        toml::Value::Float(f) => f.to_string(),
        toml::Value::Boolean(b) => b.to_string(),
        toml::Value::Datetime(d) => d.to_string(),
        toml::Value::Array(a) => format!(
            "[{}]",
            a.iter().map(value_text).collect::<Vec<_>>().join(", ")
        ),
        toml::Value::Table(t) => format!(
            "{{{}}}",
            t.iter()
                .map(|(k, v)| format!("{k} = {}", value_text(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// 設定ファイルの `key` を `literal` にする(None なら消す)。返り値は、もともと設定があったか
fn write(key: Key, literal: Option<&str>) -> anyhow::Result<bool> {
    let path = config::path();
    // 書き方が壊れているファイルは書き換えない
    config::read_table()?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (new, found) = edit_text(
        &text,
        key.name(),
        literal.map(|l| format!("{} = {l}", key.name())).as_deref(),
    );
    if !found && literal.is_none() {
        return Ok(false);
    }
    // 行の置き換えで済まない書き方(複数行の文字列など)だったら、壊す前に止める
    let parsed: Result<toml::Table, _> = toml::from_str(&new);
    let expected = literal
        .map(|l| toml::from_str::<toml::Table>(&format!("v = {l}")).map(|t| t["v"].clone()))
        .transpose()?;
    if !parsed.is_ok_and(|t| t.get(key.name()) == expected.as_ref()) {
        bail!(
            "{} の {} の書き方を自動では書き換えられません。dew config --edit で直してください",
            path.display(),
            key.name()
        );
    }
    save(&path, &new)?;
    Ok(found)
}

fn save(path: &Path, text: &str) -> anyhow::Result<()> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    // 書きかけを読まれないよう、別名で書いてから置き換える
    let tmp = path.with_extension(format!("toml.{}", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).with_context(|| format!("{} を書けません", path.display()))
}

/// 一番上の段(最初の `[表]` より前)の `key = …` の行を `line` に置き換える(None なら消す)。
/// なければ、一番上の段の最後の設定の後(表がなければファイルの最後)に足す。ほかの行はそのまま。
/// 返り値は (新しい中身, もともと行があったか)
fn edit_text(text: &str, key: &str, line: Option<&str>) -> (String, bool) {
    let mut out: Vec<&str> = Vec::new();
    let mut found = false;
    let mut root = true;
    let mut has_table = false;
    // 一番上の段の、最後の設定の行の次
    let mut after_last = 0;
    for l in text.lines() {
        let t = l.trim_start();
        if root && t.starts_with('[') {
            root = false;
            has_table = true;
        }
        if root && is_key_line(t, key) {
            if !found && let Some(n) = line {
                out.push(n);
                after_last = out.len();
            }
            found = true;
            continue;
        }
        out.push(l);
        if root && !t.is_empty() && !t.starts_with('#') {
            after_last = out.len();
        }
    }
    if !found && let Some(n) = line {
        let at = if has_table { after_last } else { out.len() };
        out.insert(at, n);
    }
    let mut s = out.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    (s, found)
}

fn is_key_line(t: &str, key: &str) -> bool {
    t.strip_prefix(key)
        .is_some_and(|rest| rest.trim_start().starts_with('='))
}

/// `dew config --edit`。git と同じく、エディタの指定には引数を含めてよい
fn edit() -> anyhow::Result<ExitCode> {
    let path = config::path();
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    let editor = ["VISUAL", "EDITOR"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "vi".to_owned());
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$@\""))
        .arg(&editor)
        .arg(&path)
        .status()
        .with_context(|| format!("エディタ({editor})を起動できません"))?;
    if !status.success() {
        bail!("エディタ({editor})が失敗しました({status})");
    }
    config::read_table()?;
    crate::note_running_server();
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_text_keeps_comments_and_tables() {
        let text = "# dew の設定\nopen_fallback_clipboard = true\n\n# CSV\n[csv]\nhost = \"x\"\n";
        let (s, found) = edit_text(text, "host", Some("host = \"192.0.2.1\""));
        assert!(!found, "表の中の同じ名前は別の設定");
        assert_eq!(
            s,
            "# dew の設定\nopen_fallback_clipboard = true\nhost = \"192.0.2.1\"\n\n# CSV\n[csv]\nhost = \"x\"\n"
        );
        let (s, found) = edit_text(&s, "host", Some("host = \"192.0.2.2\""));
        assert!(found);
        assert!(s.contains("host = \"192.0.2.2\"\n\n# CSV"), "{s}");
        let (s, found) = edit_text(&s, "host", None);
        assert!(found);
        assert_eq!(s, text);
    }

    #[test]
    fn edit_text_appends_without_tables() {
        assert_eq!(edit_text("", "port", Some("port = 1")).0, "port = 1\n");
        let (s, _) = edit_text("# メモ\nhostname = 1\n", "host", Some("host = \"a\""));
        assert_eq!(s, "# メモ\nhostname = 1\nhost = \"a\"\n");
        // 同じ名前が重なっていれば1つにまとめる
        let (s, _) = edit_text("port = 1\nport = 2\n", "port", Some("port = 3"));
        assert_eq!(s, "port = 3\n");
    }

    #[test]
    fn literal_checks_values() {
        assert_eq!(Key::Host.literal("192.0.2.1").unwrap(), "\"192.0.2.1\"");
        assert_eq!(Key::Host.literal("[::1]").unwrap(), "\"[::1]\"");
        assert!(Key::Host.literal("").is_err());
        assert!(Key::Host.literal("https://example.com").is_err());
        assert!(Key::Host.literal("a b").is_err());
        assert_eq!(Key::Port.literal("18765").unwrap(), "18765");
        assert!(Key::Port.literal("0").is_err());
        assert!(Key::Port.literal("abc").is_err());
        assert!(Key::Port.literal("70000").is_err());
    }
}
