//! シェル連携(13章): `dew shell-init` / `setup-shell` と、`dew activate` / `deactivate` がシェルに eval させるコード。
//! 実行したコマンドは呼んだシェルの環境変数を変えられないので、シェル関数 `dew` が出力を eval する(13.1)

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, bail};

/// 未設定だった変数の印(13.3)
const UNSET: &str = "__DEW_UNSET__";
/// 元の値を保存する変数の頭
const SAVED: &str = "_DEW_SAVED_";

/// `dew shell-init` が出すシェル関数(bash / zsh 共通。13.2)
const FUNCTION: &str = r#"dew() {
  case "${1:-}" in
    activate|deactivate)
      local __dew_out
      __dew_out="$(command dew "$@" --emit-shell --shell-pid $$)" || return $?
      eval "$__dew_out" ;;
    *)
      command dew "$@" ;;
  esac
}
"#;

/// `dew shell-init` の説明(--help に出す)。starship の設定例も載せる(13.5)
pub const INIT_HELP: &str = "シェル関数のコードを出す。rc ファイルに eval \"$(dew shell-init bash)\" と書いて使う(dew setup-shell でも足せる)

activate 中はプロンプトの先頭に (dew) を付ける。DEW_NO_PROMPT=1 なら付けない。
starship を使っているとき(STARSHIP_SHELL がある)は、starship がプロンプトを毎回作り直すので書き換えない。
代わりに ~/.config/starship.toml に次を足すと、activate 中に dew と出る:

  [env_var.DEW_ACTIVE]
  format = \"[dew]($style) \"
  style = \"bold blue\"";

#[derive(Clone, Copy, PartialEq, Eq, Debug, clap::ValueEnum)]
pub enum Shell {
    Bash,
    Zsh,
}

impl Shell {
    fn name(self) -> &'static str {
        match self {
            Shell::Bash => "bash",
            Shell::Zsh => "zsh",
        }
    }

    /// `$SHELL` から判定する
    fn current() -> anyhow::Result<Self> {
        let sh = std::env::var("SHELL").unwrap_or_default();
        match sh.rsplit('/').next().unwrap_or("") {
            "bash" => Ok(Shell::Bash),
            "zsh" => Ok(Shell::Zsh),
            "" => bail!("SHELL が未設定なので、シェルを判定できません"),
            other => bail!(
                "{other} には対応していません(bash と zsh のみ)。bash か zsh で dew setup-shell を実行してください"
            ),
        }
    }

    fn rc(self) -> PathBuf {
        let home = crate::state::home();
        match self {
            Shell::Bash => home.join(".bashrc"),
            Shell::Zsh => std::env::var_os("ZDOTDIR")
                .filter(|d| !d.is_empty())
                .map(PathBuf::from)
                .unwrap_or(home)
                .join(".zshrc"),
        }
    }
}

fn init_line(shell: Shell) -> String {
    format!("eval \"$(dew shell-init {})\"", shell.name())
}

/// `dew shell-init <shell>`。関数は bash と zsh で同じ
pub fn init(_shell: Shell) {
    print!(
        "# dew のシェル連携(dew activate / dew deactivate で、このシェルのアプリを dew に映す)\n{FUNCTION}"
    );
}

/// `dew setup-shell`: rc ファイルに `eval "$(dew shell-init …)"` を1行足す。すでにあれば何もしない(13.2)
pub fn setup() -> anyhow::Result<()> {
    let shell = Shell::current()?;
    let rc = shell.rc();
    let line = init_line(shell);
    let body = std::fs::read_to_string(&rc).unwrap_or_default();
    if body.lines().any(|l| l.trim() == line) {
        println!("{} には追記済みです: {line}", rc.display());
        return Ok(());
    }
    eprintln!("{} に次の1行を足します:\n  {line}", rc.display());
    eprint!("よろしいですか? [y/N] ");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    if !matches!(answer.trim(), "y" | "Y" | "yes") {
        println!("追記しませんでした");
        return Ok(());
    }
    let mut add = String::new();
    if !body.is_empty() && !body.ends_with('\n') {
        add.push('\n');
    }
    add.push_str(&format!("# dew のシェル連携(dew activate)\n{line}\n"));
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&rc)
        .and_then(|mut f| f.write_all(add.as_bytes()))
        .with_context(|| format!("{} に書けません", rc.display()))?;
    println!(
        "{} に追記しました。新しいシェルを開くか、source {} で使えます",
        rc.display(),
        rc.display()
    );
    Ok(())
}

/// activate 中か(DEW_ACTIVE は export しているので、子の dew からも見える)
pub fn active() -> bool {
    std::env::var("DEW_ACTIVE").is_ok_and(|v| v == "1")
}

/// activate で設定する値
pub struct Activate<'a> {
    pub env: &'a [(String, String)],
    pub unset: &'a [String],
    /// 精度モード: PYTHONPATH の先頭に置くフックの場所と、フックがつなぐソケット
    pub exact: Option<(String, String)>,
}

/// activate のコード: 元の値を `_DEW_SAVED_<名前>` に保存してから設定する(13.3)。保存はシェルの中で行う
/// (export していない値もあるため、子の dew からは今の値が見えないことがある)
pub fn activate_code(a: &Activate) -> String {
    let mut names: Vec<&str> = a.env.iter().map(|(k, _)| k.as_str()).collect();
    names.extend(a.unset.iter().map(String::as_str));
    if a.exact.is_some() {
        names.extend(["PYTHONPATH", "DEW_EXACT_SOCKET"]);
    }
    let mut code = String::new();
    for n in &names {
        code.push_str(&format!(
            "if [ -n \"${{{n}+x}}\" ]; then export {SAVED}{n}=\"${n}\"; else export {SAVED}{n}={UNSET}; fi\n"
        ));
    }
    for (k, v) in a.env {
        code.push_str(&format!("export {k}={}\n", crate::shell_quote(v)));
    }
    for k in a.unset {
        code.push_str(&format!("unset {k}\n"));
    }
    if let Some((hooks, socket)) = &a.exact {
        code.push_str(&format!(
            "export PYTHONPATH={}\"${{PYTHONPATH:+:$PYTHONPATH}}\"\nexport DEW_EXACT_SOCKET={}\n",
            crate::shell_quote(hooks),
            crate::shell_quote(socket)
        ));
    }
    code.push_str("export DEW_ACTIVE=1\n");
    // プロンプト(13.5): starship は毎回作り直すので触らない
    code.push_str(
        r#"if [ -z "${STARSHIP_SHELL:-}" ] && [ "${DEW_NO_PROMPT:-}" != 1 ]; then
  if [ -n "${ZSH_VERSION:-}" ]; then _DEW_PROMPT="${PROMPT-}"; PROMPT="(dew) ${PROMPT-}"
  else _DEW_PROMPT="${PS1-}"; PS1="(dew) ${PS1-}"; fi
fi
"#,
    );
    code
}

/// deactivate のコード: 保存した値に戻し(未設定だったものは unset)、印を消す(13.4)
pub fn deactivate_code() -> String {
    let mut saved: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter_map(|(k, v)| Some((k.strip_prefix(SAVED)?.to_owned(), v)))
        .filter(|(k, _)| is_name(k))
        .collect();
    saved.sort();
    let mut code = String::new();
    for (k, v) in &saved {
        if v == UNSET {
            code.push_str(&format!("unset {k}\n"));
        } else {
            code.push_str(&format!("export {k}={}\n", crate::shell_quote(v)));
        }
        code.push_str(&format!("unset {SAVED}{k}\n"));
    }
    code.push_str(
        r#"if [ -n "${_DEW_PROMPT+x}" ]; then
  if [ -n "${ZSH_VERSION:-}" ]; then PROMPT="$_DEW_PROMPT"; else PS1="$_DEW_PROMPT"; fi
  unset _DEW_PROMPT
fi
unset DEW_ACTIVE
"#,
    );
    code
}

/// シェルの変数名として使えるか(環境から読んだ名前をそのままコードに入れるため)
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(|c: char| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// シェル連携なしで activate / deactivate を実行したときの案内(13.2)
pub fn not_integrated(cmd: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "dew {cmd} はシェル連携から使います(シェルの環境変数を変えるため)。\n  dew setup-shell で rc ファイルに設定を足すか、rc ファイルに eval \"$(dew shell-init bash)\"(zsh なら zsh)と書いて、シェルを開き直してください"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked() {
        assert!(is_name("DISPLAY"));
        assert!(is_name("_A1"));
        assert!(!is_name("1A"));
        assert!(!is_name("A;rm"));
        assert!(!is_name(""));
    }
}
