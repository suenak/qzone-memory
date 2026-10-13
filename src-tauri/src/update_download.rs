//! Native package downloads from the configured manifest only; no frontend URL/path input.
use crate::updater::{request_manifest, UpdateManifest, UPDATE_ENDPOINT};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::sync::Notify;

const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const UPDATE_DIR: &str = "update-packages";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDescriptor {
    file_name: String,
    size: Option<u64>,
    platform: String,
}
pub(crate) struct SelectedPackage {
    url: reqwest::Url,
    file_name: String,
    size: Option<u64>,
    sha256: Option<String>,
    target: String,
}
impl SelectedPackage {
    pub(crate) fn descriptor(&self) -> DownloadDescriptor {
        DownloadDescriptor {
            file_name: self.file_name.clone(),
            size: self.size,
            platform: self.target.clone(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    status: &'static str,
    version: String,
    file_name: String,
    downloaded: u64,
    total: Option<u64>,
    message: String,
    #[serde(skip)]
    path: Option<PathBuf>,
    #[serde(skip)]
    digest: Option<String>,
}
impl Default for DownloadProgress {
    fn default() -> Self {
        Self {
            status: "idle",
            version: String::new(),
            file_name: String::new(),
            downloaded: 0,
            total: None,
            message: String::new(),
            path: None,
            digest: None,
        }
    }
}
#[derive(Default)]
pub struct UpdateDownloadState {
    progress: Mutex<DownloadProgress>,
    active: AtomicBool,
    cancelled: AtomicBool,
    wake_cancel: Mutex<Arc<Notify>>,
}
struct ActiveDownload<'a>(&'a UpdateDownloadState);
impl Drop for ActiveDownload<'_> {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::SeqCst);
    }
}
struct PartialFile(PathBuf);
impl Drop for PartialFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(crate) fn current_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("android", _) => Some("android"),
        _ => None,
    }
}
fn numeric_version(version: &str) -> Result<[u32; 3], String> {
    if !regex::Regex::new(r"^\d{1,5}\.\d{1,5}\.\d{1,5}$")
        .unwrap()
        .is_match(version)
    {
        return Err("更新版本号格式无法识别".into());
    }
    let parts = version
        .split('.')
        .map(|part| part.parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    Ok([parts[0], parts[1], parts[2]])
}
fn allowed_url(url: &reqwest::Url, endpoint: &reqwest::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    if url.scheme() == "https" {
        return true;
    }
    // Local development service only. Never downgrade a production HTTPS request.
    let local = matches!(
        endpoint.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]")
    );
    local && endpoint.scheme() == "http" && url.origin() == endpoint.origin()
}
pub(crate) fn select_package(
    manifest: &UpdateManifest,
    endpoint: &str,
    target: Option<&str>,
) -> Result<SelectedPackage, String> {
    numeric_version(&manifest.version)?;
    let target = target.ok_or("当前平台暂不支持应用内下载安装包，请使用下载页")?;
    let package = manifest
        .platforms
        .get(target)
        .ok_or("新版本尚未提供当前平台的安装包")?;
    let endpoint = reqwest::Url::parse(endpoint).map_err(|_| "更新服务地址无效")?;
    let url = reqwest::Url::parse(&package.url).map_err(|_| "安装包下载地址无效")?;
    if !allowed_url(&url, &endpoint) {
        return Err("安装包地址不安全，请检查更新服务配置".into());
    }
    let file_name = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .unwrap_or("")
        .to_owned();
    if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
        .unwrap()
        .is_match(&file_name)
    {
        return Err("安装包文件名无效".into());
    }
    let lower = file_name.to_ascii_lowercase();
    let valid_extension = match target {
        "windows-x86_64" => lower.ends_with(".exe") || lower.ends_with(".msi"),
        "darwin-aarch64" | "darwin-x86_64" => lower.ends_with(".dmg"),
        "android" => lower.ends_with(".apk"),
        _ => false,
    };
    if !valid_extension {
        return Err("安装包类型与当前平台不符".into());
    }
    if package
        .size
        .is_some_and(|size| size == 0 || size > MAX_PACKAGE_BYTES)
    {
        return Err("安装包大小不符合下载要求".into());
    }
    if package
        .sha256
        .as_ref()
        .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("安装包校验信息无效".into());
    }
    Ok(SelectedPackage {
        url,
        file_name,
        size: package.size,
        sha256: package.sha256.clone().map(|hash| hash.to_ascii_lowercase()),
        target: target.to_owned(),
    })
}
fn set_progress(state: &UpdateDownloadState, update: impl FnOnce(&mut DownloadProgress)) {
    if let Ok(mut progress) = state.progress.lock() {
        update(&mut progress);
    }
}
fn package_header_valid(name: &str, prefix: &[u8]) -> bool {
    let name = name.to_ascii_lowercase();
    if name.ends_with(".exe") {
        prefix.starts_with(b"MZ")
    } else if name.ends_with(".msi") {
        prefix.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    } else if name.ends_with(".apk") {
        prefix.starts_with(b"PK\x03\x04")
    } else {
        !prefix.starts_with(b"<")
    }
}
fn validate_download(
    package: &SelectedPackage,
    bytes: u64,
    hash: &str,
    prefix: &[u8],
) -> Result<(), String> {
    if bytes == 0 || package.size.is_some_and(|size| size != bytes) {
        return Err("安装包下载不完整，请重试".into());
    }
    if package
        .sha256
        .as_ref()
        .is_some_and(|expected| expected != hash)
    {
        return Err("安装包校验失败，文件可能已变更，请重新检查更新".into());
    }
    if !package_header_valid(&package.file_name, prefix) {
        return Err("下载内容不是有效的安装包，请稍后重试".into());
    }
    Ok(())
}
async fn stream_package(
    state: &UpdateDownloadState,
    wake_cancel: &Notify,
    package: &SelectedPackage,
    endpoint: &str,
    directory: &Path,
) -> Result<(PathBuf, String), String> {
    let origin = reqwest::Url::parse(endpoint).map_err(|_| "更新服务地址无效")?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30 * 60))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 || !allowed_url(attempt.url(), &origin) {
                attempt.error("unsafe download redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "无法初始化下载服务")?;
    let mut response = tokio::select! {
        _ = wake_cancel.notified() => return Err("下载已取消".into()),
        response = client.get(package.url.clone()).send() => response.map_err(|_| "无法连接下载服务，请检查网络后重试")?,
    };
    if !response.status().is_success() {
        return Err(format!(
            "安装包下载失败（HTTP {}），请稍后重试",
            response.status().as_u16()
        ));
    }
    let length = response.content_length();
    if length.is_some_and(|size| size == 0 || size > MAX_PACKAGE_BYTES)
        || length
            .zip(package.size)
            .is_some_and(|(actual, expected)| actual != expected)
    {
        return Err("安装包大小与更新信息不符，请重新检查更新".into());
    }
    let total = package.size.or(length);
    set_progress(state, |progress| {
        progress.total = total;
        progress.status = "downloading";
        progress.message = "正在下载安装包".into();
    });
    fs::create_dir_all(directory).map_err(|_| "无法创建更新下载目录，请检查磁盘空间")?;
    let partial = directory.join(format!("{}.part", package.file_name));
    let cleanup = PartialFile(partial.clone());
    let mut file = File::create(&partial).map_err(|_| "无法保存安装包，请检查磁盘空间")?;
    let mut bytes = 0u64;
    let mut hash = Sha256::new();
    let mut prefix = Vec::new();
    loop {
        if state.cancelled.load(Ordering::SeqCst) {
            return Err("下载已取消".into());
        }
        let chunk = tokio::select! {
            _ = wake_cancel.notified() => return Err("下载已取消".into()),
            chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk()) => chunk.map_err(|_| "下载长时间无响应，请检查网络后重试")?.map_err(|_| "下载连接中断，请重试")?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        bytes += chunk.len() as u64;
        if bytes > MAX_PACKAGE_BYTES || total.is_some_and(|total| bytes > total) {
            return Err("安装包超过预期大小，请重新检查更新".into());
        }
        if prefix.len() < 16 {
            prefix.extend_from_slice(&chunk[..chunk.len().min(16 - prefix.len())]);
        }
        file.write_all(&chunk)
            .map_err(|_| "保存安装包失败，请检查磁盘空间")?;
        hash.update(&chunk);
        set_progress(state, |progress| progress.downloaded = bytes);
    }
    if state.cancelled.load(Ordering::SeqCst) {
        return Err("下载已取消".into());
    }
    set_progress(state, |progress| {
        progress.status = "verifying";
        progress.message = "正在检查安装包".into();
    });
    if total.is_some_and(|total| total != bytes) {
        return Err("安装包下载不完整，请重试".into());
    }
    let digest = format!("{:x}", hash.finalize());
    validate_download(package, bytes, &digest, &prefix)?;
    file.sync_all()
        .map_err(|_| "保存安装包失败，请检查磁盘空间")?;
    if state.cancelled.load(Ordering::SeqCst) {
        return Err("下载已取消".into());
    }
    drop(file);
    let destination = directory.join(&package.file_name);
    if destination.exists() {
        fs::remove_file(&destination).map_err(|_| "旧安装包正在使用，请关闭安装程序后重试")?;
    }
    fs::rename(&partial, &destination).map_err(|_| "保存安装包失败，请稍后重试")?;
    drop(cleanup);
    Ok((destination, digest))
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateDownloadState>,
    version: String,
) -> Result<DownloadProgress, String> {
    let wake_cancel = {
        let mut notification = state.wake_cancel.lock().map_err(|_| "下载状态暂时不可用")?;
        if state
            .active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("已有安装包正在下载".into());
        }
        state.cancelled.store(false, Ordering::SeqCst);
        *notification = Arc::new(Notify::new());
        notification.clone()
    };
    let _active = ActiveDownload(&state);
    set_progress(&state, |progress| {
        *progress = DownloadProgress {
            status: "preparing",
            version: version.clone(),
            message: "正在确认最新安装包".into(),
            ..Default::default()
        }
    });
    let result: Result<(PathBuf, String), String> = async {
        let manifest = tokio::select! {
            _ = wake_cancel.notified() => return Err("下载已取消".into()),
            manifest = request_manifest(UPDATE_ENDPOINT, Duration::from_secs(10)) => manifest?,
        }
        .ok_or("这个版本已撤回，请重新检查更新")?;
        if manifest.version != version {
            return Err("更新版本已变更，请重新检查更新".into());
        }
        if numeric_version(&manifest.version)?
            <= numeric_version(&app.package_info().version.to_string())?
        {
            return Err("当前已是最新版本，无需下载安装包".into());
        }
        let package = select_package(&manifest, UPDATE_ENDPOINT, current_target())?;
        set_progress(&state, |progress| {
            progress.file_name = package.file_name.clone();
            progress.total = package.size;
        });
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|_| "无法获取更新下载目录")?
            .join(UPDATE_DIR)
            .join(&version);
        stream_package(&state, &wake_cancel, &package, UPDATE_ENDPOINT, &directory).await
    }
    .await;
    match result {
        Ok((path, digest)) => set_progress(&state, |progress| {
            progress.status = "completed";
            progress.path = Some(path);
            progress.digest = Some(digest);
            progress.message = "安装包已下载，点击打开后按系统提示安装".into();
        }),
        Err(error) => {
            let cancelled = state.cancelled.load(Ordering::SeqCst) || error == "下载已取消";
            set_progress(&state, |progress| {
                progress.status = if cancelled { "cancelled" } else { "error" };
                progress.message = error;
                progress.path = None;
            });
        }
    }
    state
        .progress
        .lock()
        .map(|progress| progress.clone())
        .map_err(|_| "下载状态暂时不可用".into())
}
#[tauri::command]
pub fn get_update_download_progress(
    state: tauri::State<'_, UpdateDownloadState>,
) -> Result<DownloadProgress, String> {
    state
        .progress
        .lock()
        .map(|progress| progress.clone())
        .map_err(|_| "下载状态暂时不可用".into())
}
#[tauri::command]
pub fn cancel_update_download(state: tauri::State<'_, UpdateDownloadState>) {
    if let Ok(notification) = state.wake_cancel.lock() {
        if state.active.load(Ordering::SeqCst) {
            state.cancelled.store(true, Ordering::SeqCst);
            notification.notify_one();
        }
    }
}
fn completed_path(state: &UpdateDownloadState) -> Result<PathBuf, String> {
    let mut progress = state.progress.lock().map_err(|_| "下载状态暂时不可用")?;
    if progress.status != "completed" {
        return Err("请先完成安装包下载".into());
    }
    let path = progress.path.clone().ok_or("安装包已不可用，请重新下载")?;
    if !path.is_file() {
        progress.status = "error";
        return Err("安装包已被移除，请重新下载".into());
    }
    let mut file = File::open(&path).map_err(|_| "无法读取安装包，请稍后重试")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "无法读取安装包，请稍后重试")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if progress.digest.as_deref() != Some(format!("{:x}", hash.finalize()).as_str()) {
        progress.status = "error";
        return Err("安装包已变更，请重新下载".into());
    }
    Ok(path)
}
#[tauri::command]
pub fn open_update_package(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateDownloadState>,
    archive: tauri::State<'_, crate::archive::ArchiveState>,
) -> Result<(), String> {
    crate::archive::ensure_archive_idle(&archive)
        .map_err(|_| "恢复或同步任务正在运行，请先停止任务再安装更新")?;
    let path = completed_path(&state)?;
    #[cfg(target_os = "android")]
    {
        return crate::android_login::open_update(&app, &path);
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|_| "无法打开安装包，请从下载文件夹手动打开".to_owned())
    }
}
#[tauri::command]
pub fn reveal_update_package(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateDownloadState>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = completed_path(&state)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "无法打开下载文件夹".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicU64;
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qza-update-test-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn manifest(url: &str, size: u64, hash: &str) -> UpdateManifest {
        serde_json::from_value(serde_json::json!({"version":"2.0.0","platforms":{"windows-x86_64":{"url":url,"size":size,"sha256":hash}}})).unwrap()
    }
    fn run_download(
        body: &[u8],
        expected_hash: &str,
        claimed_size: usize,
    ) -> (Result<(PathBuf, String), String>, PathBuf) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/manifest", listener.local_addr().unwrap());
        let url = format!("http://{}/package.exe", listener.local_addr().unwrap());
        let body = body.to_vec();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 4096];
            let count = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_lowercase();
            assert!(!request.contains("cookie:"));
            assert!(!request.contains("authorization:"));
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {claimed_size}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            socket.write_all(&body).unwrap();
        });
        let selected = select_package(
            &manifest(&url, claimed_size as u64, expected_hash),
            &endpoint,
            Some("windows-x86_64"),
        )
        .unwrap();
        let dir = temp_dir();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(stream_package(
                &UpdateDownloadState::default(),
                &Notify::new(),
                &selected,
                &endpoint,
                &dir,
            ));
        server.join().unwrap();
        (result, dir)
    }
    #[test]
    fn package_download_streams_checks_hash_and_uses_no_credentials() {
        let body = b"MZ-valid-fixture";
        let hash = format!("{:x}", Sha256::digest(body));
        let (result, dir) = run_download(body, &hash, body.len());
        let (path, digest) = result.unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(digest, hash);
        assert!(!dir.join("package.exe.part").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn truncated_and_changed_packages_leave_no_partial_or_ready_file() {
        let body = b"MZ-valid-fixture";
        for (hash, size) in [
            ("0".repeat(64), body.len()),
            (format!("{:x}", Sha256::digest(body)), body.len() + 5),
        ] {
            let (result, dir) = run_download(body, &hash, size);
            assert!(result.is_err());
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
            fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn platform_selection_rejects_unsafe_urls_and_wrong_package_types() {
        let endpoint = "https://updates.example/manifest";
        for url in [
            "http://updates.example/package.exe",
            "https://user:pass@updates.example/package.exe",
            "file:///package.exe",
            "https://updates.example/a%2fb.exe",
            "https://updates.example/package.apk",
        ] {
            assert!(select_package(
                &manifest(url, 5, &"0".repeat(64)),
                endpoint,
                Some("windows-x86_64")
            )
            .is_err());
        }
        assert!(select_package(
            &manifest("https://updates.example/package.exe", 5, &"0".repeat(64)),
            endpoint,
            Some("android")
        )
        .is_err());
        assert!(select_package(
            &manifest("https://updates.example/package.exe", 5, &"0".repeat(64)),
            endpoint,
            None
        )
        .is_err());
        let https = reqwest::Url::parse(endpoint).unwrap();
        assert!(!allowed_url(
            &reqwest::Url::parse("http://127.0.0.1/package.exe").unwrap(),
            &https
        ));
    }
    #[test]
    fn cancelled_download_stops_waiting_and_cleans_the_partial_file() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/manifest", listener.local_addr().unwrap());
        let url = format!("http://{}/package.exe", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 4096];
            socket.read(&mut request).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nMZ12",
                )
                .unwrap();
            std::thread::sleep(Duration::from_millis(500));
        });
        let package = select_package(
            &manifest(&url, 100, &"0".repeat(64)),
            &endpoint,
            Some("windows-x86_64"),
        )
        .unwrap();
        let dir = temp_dir();
        let state = UpdateDownloadState::default();
        let notify = Notify::new();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let cancel = async {
                    for _ in 0..40 {
                        if state.progress.lock().unwrap().downloaded > 0 {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    state.cancelled.store(true, Ordering::SeqCst);
                    notify.notify_one();
                };
                let (result, _) = tokio::join!(
                    stream_package(&state, &notify, &package, &endpoint, &dir),
                    cancel
                );
                result
            });
        assert_eq!(result.unwrap_err(), "下载已取消");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        server.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn opening_a_changed_or_removed_package_requires_redownload() {
        let dir = temp_dir();
        let path = dir.join("package.exe");
        fs::write(&path, b"MZ-original").unwrap();
        let state = UpdateDownloadState::default();
        *state.progress.lock().unwrap() = DownloadProgress {
            status: "completed",
            path: Some(path.clone()),
            digest: Some(format!("{:x}", Sha256::digest(b"MZ-original"))),
            ..Default::default()
        };
        assert_eq!(completed_path(&state).unwrap(), path);
        fs::write(&path, b"MZ-changed").unwrap();
        assert!(completed_path(&state).unwrap_err().contains("已变更"));
        assert_eq!(state.progress.lock().unwrap().status, "error");
        fs::remove_dir_all(dir).unwrap();
    }
}
