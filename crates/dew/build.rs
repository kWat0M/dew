//! `dew --version` に出すビルド日(UTC)を埋め込む

use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    println!("cargo:rustc-env=DEW_BUILD_DATE={y:04}-{m:02}-{d:02}");
    println!("cargo:rerun-if-changed=build.rs");
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
