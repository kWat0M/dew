//! `dew activate` 中のシェル(13.6)。PID と開始時刻で覚え、終わったシェルは点検で消す。
//! 開始時刻も見るのは、PID が再利用されて別のプロセスを取り違えないため

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct Shells {
    /// PID → 開始時刻(/proc/<pid>/stat の starttime)
    inner: Mutex<HashMap<u32, u64>>,
}

impl Shells {
    /// 登録する。そのプロセスがなければ false
    pub(crate) fn register(&self, pid: u32) -> bool {
        let Some(start) = starttime(pid) else {
            return false;
        };
        self.inner.lock().unwrap().insert(pid, start);
        true
    }

    pub(crate) fn unregister(&self, pid: u32) {
        self.inner.lock().unwrap().remove(&pid);
    }

    /// 終わったシェルを消して、残りの数を返す
    pub(crate) fn prune(&self) -> usize {
        let mut inner = self.inner.lock().unwrap();
        inner.retain(|pid, start| starttime(*pid) == Some(*start) && !zombie(*pid));
        inner.len()
    }

    pub(crate) fn count(&self) -> usize {
        self.prune()
    }
}

/// /proc/<pid>/stat の各欄。名前(2番目)に空白や `)` が入ることがあるので、最後の `)` の後ろから数える
fn stat_fields(pid: u32) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = text.rsplit_once(')')?.1;
    Some(rest.split_whitespace().map(str::to_owned).collect())
}

/// プロセスの開始時刻(起動からのクロック数)。3番目の欄(状態)から数えて 20 番目が starttime(22番目の欄)
fn starttime(pid: u32) -> Option<u64> {
    stat_fields(pid)?.get(19)?.parse().ok()
}

/// 終わったが親に回収されていないプロセス
fn zombie(pid: u32) -> bool {
    stat_fields(pid).is_some_and(|f| f.first().is_some_and(|s| s == "Z"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_live_processes_only() {
        let shells = Shells::default();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert!(shells.register(child.id()));
        assert!(shells.register(std::process::id()));
        assert_eq!(shells.count(), 2);
        // 終わったら(回収前のゾンビでも)消える
        child.kill().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(shells.count(), 1);
        child.wait().unwrap();
        assert_eq!(shells.count(), 1);
        shells.unregister(std::process::id());
        assert_eq!(shells.count(), 0);
        assert!(!shells.register(u32::MAX), "ないプロセスは登録しない");
    }

    #[test]
    fn same_pid_with_other_start_time_is_another_process() {
        let shells = Shells::default();
        let me = std::process::id();
        shells.inner.lock().unwrap().insert(me, 0);
        assert_eq!(shells.count(), 0, "開始時刻が違えば別のプロセス");
    }
}
