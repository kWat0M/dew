//! 既定の閲覧範囲(7.2): 起動したディレクトリの git ルート、git 管理外なら $HOME、$HOME の外なら起動したディレクトリ(ADR 0021)

mod common;

use common::{Instance, free_port, q};
use serde_json::Value;

fn info(a: &Instance) -> Value {
    serde_json::from_str(&a.get("/api/info").text().unwrap()).unwrap()
}

#[test]
fn default_root_is_git_toplevel() {
    let repo = tempfile::TempDir::new().unwrap();
    let repo_path = repo.path().canonicalize().unwrap();
    std::fs::create_dir_all(repo_path.join(".git")).unwrap();
    std::fs::create_dir_all(repo_path.join("out/run1")).unwrap();
    std::fs::write(repo_path.join("out/run1/a.png"), b"x").unwrap();

    let a = Instance::new();
    a.dew_in(
        &repo_path.join("out"),
        &["--port", &free_port().to_string()],
    );

    let i = info(&a);
    assert_eq!(i["root"], repo_path.to_str().unwrap());
    assert_eq!(
        i["home"],
        repo_path.join("out").to_str().unwrap(),
        "Home は起動したディレクトリ"
    );
    assert_eq!(
        a.get(&format!("/api/tree?path={}", q(&repo_path))).status(),
        200
    );
    assert_eq!(
        a.get(&format!("/api/tree?path={}", q(&repo_path.join(".."))))
            .status(),
        403
    );
    assert_eq!(a.get("/api/tree?path=%2Fetc").status(), 403);
}

#[test]
fn default_root_is_home_outside_git() {
    let a = Instance::new();
    let home = a.home.path().canonicalize().unwrap();
    let work = home.join("work");
    std::fs::create_dir(&work).unwrap();
    a.dew_in(&work, &["--port", &free_port().to_string()]);
    let i = info(&a);
    assert_eq!(i["root"], home.to_str().unwrap());
    assert_eq!(
        i["home"],
        work.to_str().unwrap(),
        "Home は起動したディレクトリ"
    );
}

// コンテナに root で入ると $HOME は空の /root で、見たいファイルは /workspace などにあることが多い。
// git 管理外で $HOME の外なら、起動したディレクトリを範囲にする(以前は $HOME になり、空のディレクトリしか見えなかった)
#[test]
fn default_root_is_start_dir_outside_git_and_home() {
    let dir = tempfile::TempDir::new().unwrap();
    let dir_path = dir.path().canonicalize().unwrap();
    std::fs::create_dir(dir_path.join("sub")).unwrap();
    let a = Instance::new();
    a.dew_in(&dir_path, &["--port", &free_port().to_string()]);
    let i = info(&a);
    assert_eq!(i["root"], dir_path.to_str().unwrap());
    assert_eq!(i["home"], dir_path.to_str().unwrap());
    assert_eq!(
        a.get(&format!("/api/tree?path={}", q(&dir_path.join("sub"))))
            .status(),
        200
    );
    assert_eq!(
        a.get(&format!("/api/tree?path={}", q(&dir_path.join(".."))))
            .status(),
        403
    );
}

// 起動したときと dew status で、閲覧範囲と変え方を出す(範囲が思ったのと違うときに気づけるように)
#[test]
fn start_and_status_show_root() {
    let dir = tempfile::TempDir::new().unwrap();
    let dir_path = dir.path().canonicalize().unwrap();
    let a = Instance::new();
    let out = a.dew_in(&dir_path, &["--port", &free_port().to_string()]);
    let err = String::from_utf8_lossy(&out.stderr);
    let want = format!("閲覧範囲: {}", dir_path.display());
    assert!(err.contains(&want) && err.contains("--root"), "{err}");
    // 動いているサーバを使い回すときも出す
    let out = a.dew_in(&dir_path, &[]);
    assert!(String::from_utf8_lossy(&out.stderr).contains(&want));
    let out = a.dew_in(&dir_path, &["status"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains(&want));
}

#[test]
fn opening_outside_root_explains_how_to_restart() {
    let repo = tempfile::TempDir::new().unwrap();
    std::fs::create_dir(repo.path().join(".git")).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let a = Instance::new();
    a.dew_in(repo.path(), &["--port", &free_port().to_string()]);

    let out = a.try_dew_in(repo.path(), &[outside.path().to_str().unwrap()]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("閲覧範囲") && err.contains("dew stop") && err.contains("--root"),
        "{err}"
    );
}
