//! 履歴(4.4): 直近に開いたファイル。~/.cache/dew/history.json に絶対パスで新しい順に持つ

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::State;
use dew_protocol::{History, HistoryAdd};

use crate::App;
use crate::files::{ApiError, entry, resolve};

/// 覚えておく件数
const LIMIT: usize = 10;

pub(crate) struct Store {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Vec<PathBuf> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// 先頭に加え、重複を除いて上限まで残す
    fn add(&self, paths: &[PathBuf]) -> std::io::Result<()> {
        let _guard = self.lock.lock().unwrap();
        let mut list: Vec<PathBuf> = paths.iter().rev().cloned().collect();
        list.dedup();
        for p in self.read() {
            if !list.contains(&p) {
                list.push(p);
            }
        }
        list.truncate(LIMIT);
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&list)?)?;
        std::fs::rename(tmp, &self.path)
    }
}

/// `GET /api/history`。今は無いファイルと、閲覧範囲の外のものは出さない
pub(crate) async fn list(State(app): State<Arc<App>>) -> Json<History> {
    let root = app.root.clone();
    let entries = app
        .history
        .read()
        .into_iter()
        .filter(|p| p.starts_with(&root) && p.is_file())
        .map(|p| {
            let mut e = entry(&p);
            e.name = relative(&root, &p);
            e
        })
        .collect();
    Json(History {
        root: root.to_string_lossy().into_owned(),
        entries,
    })
}

/// `POST /api/history`
pub(crate) async fn add(
    State(app): State<Arc<App>>,
    Json(req): Json<HistoryAdd>,
) -> Result<Json<()>, ApiError> {
    let paths = req
        .paths
        .iter()
        .map(|p| resolve(&app.root, p))
        .collect::<Result<Vec<_>, _>>()?;
    app.history
        .add(&paths)
        .map_err(|e| ApiError::Internal(format!("履歴を保存できません: {e}")))?;
    Ok(Json(()))
}

fn relative(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .into_owned()
}
