//! Shared persistent media cache: original candidates, content hashes and bounded downloads.
use crate::qlogin::QzoneAuth;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use url::Url;

static COMMIT_LOCK: Mutex<()> = Mutex::new(());
pub fn candidates(values: Vec<String>, video: bool) -> Vec<String> {
    let mut values = values;
    if !video {
        values.sort_by_key(|s| std::cmp::Reverse(quality(s)));
    }
    let mut result = Vec::new();
    for value in values {
        if !video {
            if let Some(original) = original_url(&value) {
                if !result.contains(&original) {
                    result.push(original);
                }
            }
        }
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}
fn quality(value: &str) -> u8 {
    if value.contains("/o") || value.contains("raw") || value.contains("origin") {
        100
    } else if value.contains("/r") || value.ends_with("/0") {
        90
    } else if value.contains("/b") {
        60
    } else {
        10
    }
}
pub fn original_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if !url.host_str().is_some_and(|h| {
        h.ends_with(".photo.store.qq.com") || h == "qpic.cn" || h.ends_with(".qpic.cn")
    }) {
        return None;
    }
    if !value.contains("/psc?/") {
        return None;
    }
    let bang = value.find("!/")?;
    Some(format!("{}o", &value[..bang + 2]))
}
fn url_key(value: &str) -> String {
    if original_url(value).as_deref() == Some(value) {
        if let Some(start) = value.find("/psc?/") {
            return hash(value[start..].as_bytes());
        }
    }
    hash(value.as_bytes())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn cache_db(dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let db = Connection::open(dir.join("media-index.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS media(url_hash TEXT PRIMARY KEY,content_hash TEXT NOT NULL,file_name TEXT NOT NULL,bytes INTEGER NOT NULL);").map_err(|e| e.to_string())?;
    Ok(db)
}
fn usable(dir: &Path, name: &str, bytes: u64) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    let path = dir.join(name);
    path.metadata()
        .ok()
        .filter(|m| m.is_file() && m.len() == bytes && bytes > 32)
        .map(|_| path)
}
pub fn cached(dir: &Path, urls: &[String]) -> Result<Option<PathBuf>, String> {
    let db = cache_db(dir)?;
    for url in urls {
        let key = url_key(url);
        if let Ok((name, size)) = db.query_row(
            "SELECT file_name,bytes FROM media WHERE url_hash=?1",
            [key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)),
        ) {
            if let Some(path) = usable(dir, &name, size) {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}
fn commit(
    dir: &Path,
    temp: &Path,
    urls: &[String],
    digest: &str,
    bytes: u64,
    timestamp: i64,
    ext: &str,
) -> Result<PathBuf, String> {
    let _lock = COMMIT_LOCK.lock().map_err(|_| "媒体保存暂时不可用")?;
    let mut db = cache_db(dir)?;
    let old = db
        .query_row(
            "SELECT file_name,bytes FROM media WHERE content_hash=?1 LIMIT 1",
            [digest],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)),
        )
        .ok()
        .and_then(|(n, s)| usable(dir, &n, s));
    let path = if let Some(path) = old {
        fs::remove_file(temp).map_err(|e| e.to_string())?;
        path
    } else {
        let stamp: String = if timestamp > 0 {
            db.query_row(
                "SELECT strftime('%Y-%m-%d_%H-%M-%S',?1,'unixepoch','localtime')",
                [timestamp],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "时间未知".into())
        } else {
            "时间未知".into()
        };
        let path = dir.join(format!("{stamp}_{digest}.{ext}"));
        if path.exists() && path.metadata().is_ok_and(|m| m.len() == bytes) {
            fs::remove_file(temp).map_err(|e| e.to_string())?;
        } else {
            fs::rename(temp, &path).map_err(|e| e.to_string())?;
        }
        path
    };
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for url in urls {
        tx.execute(
            "INSERT OR REPLACE INTO media VALUES(?1,?2,?3,?4)",
            params![
                url_key(url),
                digest,
                path.file_name().unwrap().to_string_lossy(),
                bytes
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(path)
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub async fn download(
    dir: &Path,
    auth: &QzoneAuth,
    values: Vec<String>,
    timestamp: i64,
    video: bool,
) -> Result<PathBuf, String> {
    let urls = candidates(values, video);
    if let Some(path) = cached(dir, &urls)? {
        return Ok(path);
    }
    let client = reqwest::Client::builder()
        .redirect(crate::media_http::redirect_policy())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let anonymous_client = reqwest::Client::builder()
        .redirect(crate::media_http::anonymous_redirect_policy())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let limit = if video {
        300 * 1024 * 1024u64
    } else {
        50 * 1024 * 1024u64
    };
    let mut last = "没有可用的媒体地址".to_string();
    for value in &urls {
        let url = match crate::media_http::media_url(value) {
            Ok(u) => u,
            Err(e) => {
                last = e;
                continue;
            }
        };
        for (cookie, referer) in [(true, true), (false, true), (true, false), (false, false)] {
            let mut request = crate::media_http::request(
                if cookie { &client } else { &anonymous_client },
                &url,
                &auth.cookie_header,
                cookie,
            )
            .header(reqwest::header::USER_AGENT, &auth.user_agent);
            if referer {
                request = request.header(reqwest::header::REFERER, "https://user.qzone.qq.com/");
            }
            let mut response = match request.send().await {
                Ok(r) => r,
                Err(_) => {
                    last = "媒体连接失败，请检查网络后重试".into();
                    continue;
                }
            };
            if !response.status().is_success() {
                last = format!("媒体读取失败（HTTP {}）", response.status().as_u16());
                continue;
            }
            if response.content_length().is_some_and(|s| s > limit) {
                last = "媒体文件超过大小限制".into();
                continue;
            }
            let mut random = [0u8; 16];
            getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
            let temp = Temporary(dir.join(format!("{}.part", hash(&random))));
            let mut file = fs::File::create(&temp.0).map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut size = 0u64;
            let mut head = Vec::new();
            let mut failed = false;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        size += chunk.len() as u64;
                        if size > limit {
                            last = "媒体文件超过大小限制".into();
                            failed = true;
                            break;
                        }
                        if head.len() < 4096 {
                            head.extend_from_slice(&chunk[..chunk.len().min(4096 - head.len())]);
                        }
                        digest.update(&chunk);
                        file.write_all(&chunk).map_err(|e| e.to_string())?;
                    }
                    Ok(None) => break,
                    Err(_) => {
                        last = "下载中断，请重试".into();
                        failed = true;
                        break;
                    }
                }
            }
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            if failed || size <= 32 {
                continue;
            }
            let ext = if video {
                if head
                    .get(4..12)
                    .is_some_and(|s| s.windows(4).any(|v| v == b"ftyp"))
                {
                    Some("mp4")
                } else if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
                    Some("webm")
                } else {
                    None
                }
            } else if crate::archive::is_qq_missing_image_placeholder(&head) {
                None
            } else {
                crate::archive::archived_image_extension(&head)
            };
            let Some(ext) = ext else {
                last = if video {
                    "播放地址未返回完整视频文件，可能只剩封面"
                } else {
                    "原图已不存在或返回的不是图片"
                }
                .into();
                continue;
            };
            if ext == "mp4" && !crate::archive::is_complete_mp4(&temp.0) {
                last = "视频下载不完整，请重试".into();
                continue;
            }
            let digest = format!("{:x}", digest.finalize());
            // Alias only the URL that actually succeeded. A low-quality fallback must not
            // masquerade as a successful original download on the next request.
            return commit(
                dir,
                &temp.0,
                &[value.clone()],
                &digest,
                size,
                timestamp,
                ext,
            );
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn originals_are_restricted_and_sorted() {
        assert_eq!(
            original_url("https://a.photo.store.qq.com/psc?/a/token!/b&w=100"),
            Some("https://a.photo.store.qq.com/psc?/a/token!/o".into())
        );
        assert!(original_url("https://example.com/psc?/a/token!/b").is_none());
        assert_eq!(
            candidates(vec!["https://a.qpic.cn/psc?/a/t!/b".into()], false).len(),
            2
        );
    }
    #[test]
    fn content_dedup_reuses_files_and_rejects_truncation() {
        let dir = std::env::temp_dir().join(format!("shiyi-media-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for url in ["https://a.qpic.cn/1", "https://a.qpic.cn/2"] {
            let temp = dir.join("test.part");
            fs::write(&temp, [42u8; 64]).unwrap();
            commit(
                &dir,
                &temp,
                &[url.into()],
                &hash(&[42u8; 64]),
                64,
                1000,
                "jpg",
            )
            .unwrap();
        }
        let a = cached(&dir, &["https://a.qpic.cn/1".into()])
            .unwrap()
            .unwrap();
        assert_eq!(
            Some(a.clone()),
            cached(&dir, &["https://a.qpic.cn/2".into()]).unwrap()
        );
        fs::write(a, b"broken").unwrap();
        assert!(cached(&dir, &["https://a.qpic.cn/1".into()])
            .unwrap()
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
