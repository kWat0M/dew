//! `dew update`: 新しい版を取得して自分自身を置き換える(3.1、7.10、ADR 0018)。
//! GitHub の Releases の最新の版を見て、今より新しければ tar.gz を取り、SHA256SUMS で確かめてから入れ替える。
//! 公開リポジトリなら GitHub の API で、非公開なら `gh`(ログイン済みのとき)で取る。どちらも使えなければ、
//! 手で入れ替える方法を出す

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, bail};
use serde::Deserialize;

/// 更新元のリポジトリ(`DEW_UPDATE_REPO` で変えられる)
/// バイナリだけを置く公開リポジトリ(ソースのリポジトリは非公開。ADR 0018)
const DEFAULT_REPO: &str = "kWat0M/dew-releases";
/// 配布物の名前の終わり(scripts/release.sh)
const ASSET_SUFFIX: &str = "-x86_64-linux.tar.gz";

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

pub fn run() -> anyhow::Result<()> {
    let repo = std::env::var("DEW_UPDATE_REPO").unwrap_or_else(|_| DEFAULT_REPO.into());
    let current = env!("CARGO_PKG_VERSION");
    let dir = tempfile::tempdir().context("作業用のディレクトリを作れません")?;

    let (tag, tarball) = match latest_by_api(&repo) {
        Ok(Some(rel)) => {
            if !newer(&rel.tag_name, current) {
                println!(
                    "dew {current} は最新です({} が最新のリリース)",
                    rel.tag_name
                );
                return Ok(());
            }
            let asset = rel
                .assets
                .iter()
                .find(|a| a.name.ends_with(ASSET_SUFFIX))
                .with_context(|| {
                    format!("{} に配布物(…{ASSET_SUFFIX})がありません", rel.tag_name)
                })?;
            let path = dir.path().join(&asset.name);
            download(&asset.browser_download_url, &path)?;
            (rel.tag_name, path)
        }
        // 見つからない: 非公開リポジトリか、まだリリースがない。gh があればそちらで
        Ok(None) => match latest_by_gh(&repo, current, dir.path()) {
            Ok(Some(found)) => found,
            Ok(None) => return Ok(()),
            Err(e) => {
                manual(&repo, &format!("{e:#}"));
                bail!("更新できませんでした");
            }
        },
        Err(e) => {
            manual(&repo, &format!("{e:#}"));
            bail!("更新できませんでした");
        }
    };

    let new_bin = unpack(&tarball, dir.path())?;
    let target = std::env::current_exe().context("今の dew の場所が分かりません")?;
    replace(&new_bin, &target)?;
    println!("dew を {tag} に更新しました({})", target.display());
    if crate::state::read().is_some() {
        println!(
            "動いているサーバは前の版のままです。dew stop してから dew で起動し直してください"
        );
    }
    Ok(())
}

/// GitHub の API で最新のリリースを見る。見つからない(非公開・リリースなし)なら None
fn latest_by_api(repo: &str) -> anyhow::Result<Option<Release>> {
    let base = std::env::var("DEW_UPDATE_API").unwrap_or_else(|_| "https://api.github.com".into());
    let res = client()?
        .get(format!("{base}/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .context("GitHub に問い合わせられません(ネットワークにつながっているか確かめてください)")?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let res = res
        .error_for_status()
        .context("GitHub の応答が正しくありません")?;
    Ok(Some(res.json().context("リリースの情報を読めません")?))
}

/// 非公開リポジトリ: ログイン済みの gh で最新のリリースを見て、配布物を取る。最新なら None
fn latest_by_gh(
    repo: &str,
    current: &str,
    dir: &Path,
) -> anyhow::Result<Option<(String, PathBuf)>> {
    let out = Command::new("gh")
        .args([
            "release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName",
        ])
        .output()
        .context("リリースが見つからず、gh(GitHub CLI)もありません")?;
    if !out.status.success() {
        bail!(
            "リリースが見つかりません(非公開なら gh auth login が要ります): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let tag = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !newer(&tag, current) {
        println!("dew {current} は最新です({tag} が最新のリリース)");
        return Ok(None);
    }
    let status = Command::new("gh")
        .args(["release", "download", &tag, "--repo", repo, "--pattern"])
        .arg(format!("*{ASSET_SUFFIX}"))
        .arg("--dir")
        .arg(dir)
        .status()
        .context("gh で配布物を取れません")?;
    if !status.success() {
        bail!("gh で {tag} の配布物を取れません");
    }
    let path = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().ends_with(ASSET_SUFFIX))
        .with_context(|| format!("{tag} に配布物(…{ASSET_SUFFIX})がありません"))?;
    Ok(Some((tag, path)))
}

fn client() -> anyhow::Result<reqwest::blocking::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(reqwest::blocking::Client::builder()
        .user_agent(concat!("dew/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()?)
}

fn download(url: &str, to: &Path) -> anyhow::Result<()> {
    println!("取得しています: {url}");
    let bytes = client()?
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .with_context(|| format!("{url} を取れません"))?
        .bytes()?;
    std::fs::write(to, &bytes)?;
    Ok(())
}

/// tar.gz を開き、SHA256SUMS で dew が壊れていないか確かめて、その場所を返す
fn unpack(tarball: &Path, dir: &Path) -> anyhow::Result<PathBuf> {
    let out = dir.join("unpacked");
    std::fs::create_dir_all(&out)?;
    let ok = Command::new("tar")
        .arg("-xzf")
        .arg(tarball)
        .arg("-C")
        .arg(&out)
        .status()
        .context("tar を実行できません")?;
    if !ok.success() {
        bail!("配布物を展開できません");
    }
    // 中は dew-<版>-<コミット>-x86_64-linux/ の 1 つのディレクトリ
    let inner = std::fs::read_dir(&out)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.join("dew").is_file())
        .context("配布物の中に dew がありません")?;
    let check = Command::new("sha256sum")
        .args(["--quiet", "-c", "SHA256SUMS"])
        .current_dir(&inner)
        .status()
        .context("sha256sum を実行できません")?;
    if !check.success() {
        bail!("取得した dew が SHA256SUMS と合いません(壊れているか、途中で切れています)");
    }
    Ok(inner.join("dew"))
}

/// `target` を `new` で置き換える。同じディレクトリに書いてから rename するので、途中で失敗しても壊れない
fn replace(new: &Path, target: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir = target.parent().context("dew の置き場所が分かりません")?;
    let tmp = dir.join(".dew.update");
    std::fs::copy(new, &tmp).with_context(|| {
        format!(
            "{} に書けません。書ける場所に dew を置くか、手で入れ替えてください",
            dir.display()
        )
    })?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    std::fs::rename(&tmp, target)
        .with_context(|| format!("{} を置き換えられません", target.display()))?;
    Ok(())
}

/// 自動で更新できないときの案内
fn manual(repo: &str, reason: &str) {
    eprintln!("dew: 自動で更新できません: {reason}");
    eprintln!("dew: 次のどれかで更新してください");
    eprintln!(
        "  - 作者から新しい版の tar.gz を受け取り、README の「入れ方」のとおり dew を置き換える"
    );
    eprintln!("  - https://github.com/{repo}/releases から取る(見られる場合)");
    eprintln!("  - 非公開のリポジトリなら、gh auth login してから dew update");
}

/// `tag`(v0.2.0 など)が `current`(0.1.0 など)より新しいか
fn newer(tag: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split(['.', '-'])
            .take(3)
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    parse(tag) > parse(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(newer("v0.2.0", "0.1.0"));
        assert!(newer("v0.1.1", "0.1.0"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(newer("0.10.0", "0.9.0"));
        assert!(!newer("v0.1.0", "0.1.0"));
        assert!(!newer("v0.0.9", "0.1.0"));
    }
}
