//! 既定の閲覧範囲(7.2): 起動したディレクトリの git ルート、git 管理外なら $HOME

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
    let dir = tempfile::TempDir::new().unwrap();
    let a = Instance::new();
    a.dew_in(dir.path(), &["--port", &free_port().to_string()]);
    let home = a.home.path().canonicalize().unwrap();
    let i = info(&a);
    assert_eq!(i["root"], home.to_str().unwrap());
    // 起動したディレクトリが範囲外なので、Home は範囲の起点で開く
    assert_eq!(i["home"], home.to_str().unwrap());
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
