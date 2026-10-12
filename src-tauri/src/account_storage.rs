//! Per-account storage. Legacy databases remain untouched until users remove their backups.
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

static MIGRATION_LOCK: Mutex<()> = Mutex::new(());
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccount {
    uin: String,
    selected: bool,
}

fn legacy_accounts(root: &Path) -> Vec<String> {
    let Ok(db) = Connection::open_with_flags(
        root.join("qzone-archive.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return Vec::new();
    };
    let mut accounts = std::collections::BTreeSet::new();
    for table in ["archive_dynamics", "archive_library_items", "archive_feeds"] {
        if let Ok(mut stmt) = db.prepare(&format!("SELECT DISTINCT owner_uin FROM {table}")) {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                accounts.extend(rows.filter_map(Result::ok).filter(|s| valid_uin(s)));
            }
        }
    }
    accounts.into_iter().collect()
}

#[tauri::command]
pub async fn list_local_accounts(app: tauri::AppHandle) -> Result<Vec<LocalAccount>, String> {
    crate::license::require_read_access()?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = directory(&app)?;
        let data_root = root(&app)?;
        let accounts = data_root.join("accounts");
        let mut result = Vec::new();
        if accounts.is_dir() {
            for entry in fs::read_dir(accounts).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(uin) = name.strip_prefix("qq_").filter(|s| valid_uin(s)) {
                    result.push(LocalAccount {
                        uin: uin.into(),
                        selected: entry.path() == selected,
                    });
                }
            }
        }
        for uin in legacy_accounts(&data_root) {
            if !result.iter().any(|a| a.uin == uin) {
                result.push(LocalAccount {
                    uin,
                    selected: false,
                });
            }
        }
        result.sort_by(|a, b| a.uin.cmp(&b.uin));
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn select_local_account(app: tauri::AppHandle, uin: String) -> Result<(), String> {
    crate::license::require_read_access()?;
    crate::archive::ensure_archive_idle(&app.state::<crate::archive::ArchiveState>())?;
    if app
        .state::<crate::qlogin::QLoginState>()
        .current_uin()?
        .is_some()
    {
        return Err("请先退出 QQ 登录，再切换本地账号".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&app)?;
        if !valid_uin(&uin)
            || (!root.join("accounts").join(format!("qq_{uin}")).is_dir()
                && !legacy_accounts(&root).contains(&uin))
        {
            return Err("本机没有这个账号的记录".into());
        }
        let _lock = MIGRATION_LOCK
            .lock()
            .map_err(|_| "账号数据目录暂时不可用")?;
        migrate(
            &root,
            &root.join("accounts").join(format!("qq_{uin}")),
            &uin,
        )?;
        if app
            .state::<crate::qlogin::QLoginState>()
            .current_uin()?
            .is_some()
        {
            return Err("登录状态已改变，请退出 QQ 后再切换本地账号".into());
        }
        fs::write(root.join("last-account.txt"), uin).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn valid_uin(uin: &str) -> bool {
    !uin.is_empty() && uin.len() <= 20 && uin.bytes().all(|b| b.is_ascii_digit())
}

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

pub fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = root(app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let _lock = MIGRATION_LOCK
        .lock()
        .map_err(|_| "账号数据目录暂时不可用")?;
    let current = app.state::<crate::qlogin::QLoginState>().current_uin()?;
    let previous = fs::read_to_string(root.join("last-account.txt"))
        .ok()
        .filter(|s| valid_uin(s));
    let uin = current.or(previous).or_else(|| legacy_owner(&root));
    let Some(uin) = uin else {
        return Ok(root.join("accounts").join("local"));
    };
    if !valid_uin(&uin) {
        return Err("QQ 账号格式无效".into());
    }
    let dir = root.join("accounts").join(format!("qq_{uin}"));
    migrate(&root, &dir, &uin)?;
    // This selector contains only a QQ number, never cookies or credentials.
    fs::write(root.join("last-account.txt"), &uin).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn legacy_owner(root: &Path) -> Option<String> {
    let db = Connection::open_with_flags(
        root.join("qzone-archive.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    ["archive_dynamics", "archive_library_items", "archive_feeds"]
        .iter()
        .find_map(|table| {
            db.query_row(
                &format!("SELECT owner_uin FROM {table} ORDER BY archived_at DESC LIMIT 1"),
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .filter(|s| valid_uin(s))
        })
}

fn copy_files(from: &Path, to: &Path, prefix: Option<&str>) -> Result<(), String> {
    if !from.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        if prefix.is_some_and(|p| !entry.file_name().to_string_lossy().starts_with(p)) {
            continue;
        }
        let dest = to.join(entry.file_name());
        if !dest.exists() {
            fs::copy(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn migrate(root: &Path, dir: &Path, uin: &str) -> Result<(), String> {
    if !valid_uin(uin) {
        return Err("QQ 账号格式无效".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join("qzone-archive.sqlite3");
    let legacy = root.join("qzone-archive.sqlite3");
    if !dest.exists() && legacy.is_file() {
        let temp = dir.join("migration.sqlite3");
        if temp.exists() {
            fs::remove_file(&temp).map_err(|e| e.to_string())?;
        }
        let source = Connection::open_with_flags(&legacy, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        // VACUUM INTO takes a consistent SQLite snapshot, including committed WAL data.
        source
            .execute("VACUUM INTO ?1", [temp.to_string_lossy().as_ref()])
            .map_err(|e| format!("迁移旧数据失败：{e}"))?;
        let mut target = Connection::open(&temp).map_err(|e| e.to_string())?;
        let tables = target
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let tx = target.transaction().map_err(|e| e.to_string())?;
        for table in tables {
            let escaped = table.replace('"', "\"\"");
            let has_owner = tx
                .prepare(&format!("PRAGMA table_info(\"{escaped}\")"))
                .map_err(|e| e.to_string())?
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .any(|v| v.is_ok_and(|c| c == "owner_uin"));
            if has_owner {
                tx.execute(
                    &format!("DELETE FROM \"{escaped}\" WHERE owner_uin<>?1"),
                    [uin],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        target
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
            .map_err(|e| e.to_string())?;
        drop(target);
        fs::rename(temp, &dest).map_err(|e| e.to_string())?;
    }
    if !dir.join("media-migrated").exists() {
        copy_files(&root.join("images").join(uin), &dir.join("images"), None)?;
        fs::write(dir.join("media-migrated"), b"1").map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn migrate_videos(app: &tauri::AppHandle, dir: &Path, uin: &str) -> Result<(), String> {
    if dir.join("videos-migrated").exists() {
        return Ok(());
    }
    let old = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("videos");
    copy_files(&old, &dir.join("videos"), Some(&format!("{uin}-")))?;
    fs::write(dir.join("videos-migrated"), b"1").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_keeps_ids_and_separates_accounts() {
        let root = std::env::temp_dir().join(format!("shiyi-migrate-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let old = Connection::open(root.join("qzone-archive.sqlite3")).unwrap();
        old.execute_batch("CREATE TABLE archive_dynamics(id INTEGER PRIMARY KEY,owner_uin TEXT,archived_at INTEGER); INSERT INTO archive_dynamics VALUES(7,'123',1),(8,'456',2);").unwrap();
        for (uin, id) in [("123", 7), ("456", 8)] {
            let dir = root.join(format!("qq_{uin}"));
            migrate(&root, &dir, uin).unwrap();
            let db = Connection::open(dir.join("qzone-archive.sqlite3")).unwrap();
            assert_eq!(
                db.query_row("SELECT id FROM archive_dynamics", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                id
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM archive_dynamics", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        assert_eq!(
            old.query_row("SELECT COUNT(*) FROM archive_dynamics", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(old);
        fs::remove_dir_all(root).unwrap();
        assert!(!valid_uin("../123"));
    }
}
