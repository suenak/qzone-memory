//! 客户端更新：只做「检查新版本 + 引导到官网手动下载」。
//!
//! 曾经实现过应用内自动安装（桌面走官方 updater 插件、Android 自建 APK 安装器），
//! 但那要维护一对 minisign 密钥、Android 的 FileProvider 与「安装未知应用」权限，
//! 而且在两端都很难让用户看清「这次更新到底改了什么」。现在改成：
//! 请求更新清单 → 展示版本号与更新内容 → 用户自己决定是否前往官网下载覆盖安装。
//!
//! 这样一来既没有静默安装的权限负担，也不需要在客户端内置任何签名公钥。

use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_MANIFEST_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    download_page: Option<String>,
}

async fn request_manifest(
    endpoint: &str,
    timeout: Duration,
) -> Result<Option<UpdateManifest>, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化更新请求".to_owned())?;
    let mut response = client
        .get(endpoint)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| "无法连接更新服务，请检查网络或稍后重试".to_owned())?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("更新服务返回 {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_MANIFEST_BYTES as u64)
    {
        return Err("更新信息过大，请稍后重试".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取更新信息失败，请稍后重试".to_owned())?
    {
        if bytes.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err("更新信息过大，请稍后重试".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "更新信息格式有误，请稍后重试".to_owned())
}

/// 仅请求编译时配置的清单地址，不接收前端传入的网址或 QQ 凭据。
#[tauri::command]
pub async fn fetch_update_manifest() -> Result<Option<UpdateManifest>, String> {
    request_manifest(UPDATE_ENDPOINT, Duration::from_secs(10)).await
}

/// 更新清单地址。
///
/// 发布时用编译期环境变量 `QZA_UPDATE_ENDPOINT` 覆盖，或在源码里改这里的默认值。
/// 清单格式见 `docs/RELEASE-AUTO-UPDATE.md`。
pub const UPDATE_ENDPOINT: &str = match option_env!("QZA_UPDATE_ENDPOINT") {
    Some(value) => value,
    None => "https://updates.invalid/api/v1/update/latest",
};

/// 官网下载页兜底地址。
///
/// 优先级低于清单里的 `download_page`:清单可以随版本改地址，而不必重新发客户端。
/// 只有清单没有给、或者解析失败时才用这里。
pub const DOWNLOAD_PAGE: &str = match option_env!("QZA_DOWNLOAD_PAGE") {
    Some(value) => value,
    None => "https://updates.invalid/download",
};

#[tauri::command]
pub fn update_endpoint() -> String {
    UPDATE_ENDPOINT.to_owned()
}

#[tauri::command]
pub fn download_page() -> String {
    DOWNLOAD_PAGE.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn fetch_fixture(response: String) -> Result<Option<UpdateManifest>, String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/manifest", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            let size = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]).to_lowercase();
            assert!(!request.contains("cookie:"));
            assert!(!request.contains("authorization:"));
            socket.write_all(response.as_bytes()).unwrap();
        });
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(request_manifest(&endpoint, Duration::from_secs(5)));
        server.join().unwrap();
        result
    }

    #[test]
    fn native_manifest_fetch_needs_no_cors_headers_or_credentials() {
        let body = r#"{"version":"1.2.0","notes":"test","download_page":"https://example.com/"}"#;
        let manifest = fetch_fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        ))
        .unwrap()
        .unwrap();
        assert_eq!(manifest.version, "1.2.0");
        assert_eq!(manifest.notes.as_deref(), Some("test"));
    }

    #[test]
    fn native_manifest_fetch_handles_no_update_and_rejects_invalid_responses() {
        assert!(
            fetch_fixture("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".into())
                .unwrap()
                .is_none()
        );
        assert!(fetch_fixture(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into()
        )
        .is_err());
        assert!(fetch_fixture(
            "HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\nConnection: close\r\n\r\n".into()
        )
        .is_err());
        assert!(fetch_fixture(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into()
        )
        .is_err());
    }
}
