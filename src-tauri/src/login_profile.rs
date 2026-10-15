//! QQ profile lookup stays native: the WebView receives display fields only.
use crate::{media_http, qlogin::QLoginState};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginUser {
    uin: String,
    nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_image: Option<String>,
}

fn profile_data(bytes: &[u8]) -> Result<Value, String> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => std::borrow::Cow::Borrowed(text),
        Err(_) => encoding_rs::GB18030.decode(bytes).0,
    };
    let start = text.find('{').ok_or("用户资料格式不正确")?;
    let end = text.rfind('}').ok_or("用户资料格式不正确")?;
    if end < start {
        return Err("用户资料格式不正确".into());
    }
    let value: Value =
        serde_json::from_str(&text[start..=end]).map_err(|_| "用户资料格式不正确")?;
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return Err("QQ 用户资料暂时不可用".into());
    }
    value
        .get("data")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or("用户资料缺少内容".into())
}

#[tauri::command]
pub async fn get_login_user(state: tauri::State<'_, QLoginState>) -> Result<LoginUser, String> {
    crate::license::require_archive_access()?;
    let epoch = state.session_epoch();
    let auth = state.qzone_auth().await?;
    let client = state.client(); // No automatic redirects; credentials cannot leave this endpoint.
    let mut profile = None;
    for endpoint in [
        "https://h5.qzone.qq.com/proxy/domain/vip.qzone.qq.com/fcg-bin/fcg_get_vipinfo_mobile",
        "https://h5.qzone.qq.com/proxy/domain/base.qzone.qq.com/cgi-bin/user/cgi_userinfo_get_all",
    ] {
        if epoch != state.session_epoch() {
            return Err("登录状态已改变".into());
        }
        let response = client
            .get(endpoint)
            .query(&[
                ("uin", auth.uin.as_str()),
                ("vuin", auth.uin.as_str()),
                ("g_tk", &auth.g_tk.to_string()),
                ("get_all", "1"),
                ("fupdate", "1"),
            ])
            .header(COOKIE, &auth.cookie_header)
            .header(REFERER, format!("https://user.qzone.qq.com/{}", auth.uin))
            .header(USER_AGENT, &auth.user_agent)
            .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        if let Ok(response) = response {
            if response.status().is_success() {
                if let Ok(bytes) = media_http::bounded_body(response, 1024 * 1024).await {
                    if let Ok(data) = profile_data(&bytes) {
                        profile = Some(data);
                        break;
                    }
                }
            }
        }
    }
    if epoch != state.session_epoch() {
        return Err("登录状态已改变".into());
    }
    let profile = profile.ok_or("QQ 用户资料暂时不可用")?;
    let nickname = ["nickname", "nick", "name"]
        .iter()
        .find_map(|key| {
            profile
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("QQ 用户")
        .chars()
        .take(200)
        .collect();
    // Use the public QQ avatar endpoint, never a server-provided arbitrary URL.
    let avatar_url = format!("https://q1.qlogo.cn/g?b=qq&nk={}&s=100", auth.uin);
    let avatar_image = match client
        .get(avatar_url)
        .header(USER_AGENT, &auth.user_agent)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            media_http::image_body(response, 512 * 1024)
                .await
                .ok()
                .map(|(mime, bytes)| format!("data:{mime};base64,{}", BASE64.encode(bytes)))
        }
        _ => None,
    };
    if epoch != state.session_epoch() {
        return Err("登录状态已改变".into());
    }
    Ok(LoginUser {
        uin: auth.uin,
        nickname,
        avatar_image,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_jsonp_and_gbk_without_evaluating_scripts() {
        let text = "cb({\"code\":0,\"data\":{\"nickname\":\"拾忆\"}});";
        assert_eq!(profile_data(text.as_bytes()).unwrap()["nickname"], "拾忆");
        let (bytes, _, _) = encoding_rs::GB18030.encode(text);
        assert_eq!(profile_data(&bytes).unwrap()["nickname"], "拾忆");
        for invalid in [
            "cb({\"code\":1,\"data\":{}})",
            "cb({\"code\":0})",
            "{\"code\":0,\"data\":[]}",
            "}ignored{",
        ] {
            assert!(profile_data(invalid.as_bytes()).is_err());
        }
    }
}
