//! `dew --version` に出す、ビルドしたコミットとビルド日(UTC)を埋め込む。
//! 配布したバイナリがどの版かを見分けられるように、コミットが変わるたびに作り直す

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    let commit = commit().unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=DEW_BUILD_DATE={y:04}-{m:02}-{d:02}");
    println!("cargo:rustc-env=DEW_COMMIT={commit}");
    println!("cargo:rerun-if-changed=build.rs");
}

/// 今のコミットの短いハッシュ。git コマンドは使わず .git を読む(ソースの tar から作るときは無い)
fn commit() -> Option<String> {
    let git = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.git");
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    println!("cargo:rerun-if-changed={}", git.join("HEAD").display());
    let hash = match head.trim().strip_prefix("ref: ") {
        Some(r) => {
            let path = git.join(r);
            println!("cargo:rerun-if-changed={}", path.display());
            match std::fs::read_to_string(&path) {
                Ok(h) => h,
                // git gc の後は refs が packed-refs にまとまっている
                Err(_) => {
                    println!(
                        "cargo:rerun-if-changed={}",
                        git.join("packed-refs").display()
                    );
                    std::fs::read_to_string(git.join("packed-refs"))
                        .ok()?
                        .lines()
                        .find(|l| l.ends_with(r))?
                        .split_whitespace()
                        .next()?
                        .to_owned()
                }
            }
        }
        None => head,
    };
    Some(hash.trim().chars().take(7).collect())
}

/// UNIX エポックからの日数を年月日にする(Howard Hinnant の days_from_civil の逆)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
