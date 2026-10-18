//! 精度モード(L3)の Python フック。バイナリに同梱し、`~/.cache/dew/python/` に書き出して使う(7.10。pip は使わない)

use std::path::PathBuf;

use anyhow::Context;

use crate::state;

const FILES: &[(&str, &str)] = &[
    (
        "sitecustomize.py",
        include_str!("../../../python/dew_hooks/sitecustomize.py"),
    ),
    (
        "dew_exact.py",
        include_str!("../../../python/dew_hooks/dew_exact.py"),
    ),
];

/// フックを書き出し、その置き場所(PYTHONPATH に入れるディレクトリ)を返す。中身が同じなら書き直さない
pub fn install() -> anyhow::Result<PathBuf> {
    let dir = state::cache_dir().join("python");
    std::fs::create_dir_all(&dir).with_context(|| format!("{} を作れません", dir.display()))?;
    for (name, body) in FILES {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(*body) {
            std::fs::write(&path, body)
                .with_context(|| format!("{} を書けません", path.display()))?;
        }
    }
    Ok(dir)
}
