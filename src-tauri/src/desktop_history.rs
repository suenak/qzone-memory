//! Desktop personal interaction history. Scope 1 is essential: scope 0 is
//! the friends stream and must never stand in for recovered personal history.
use super::{decode_history_page, decode_history_response, HistoryMessagePage};
use crate::{history_response, qlogin::QLoginState};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const URL: &str =
    "https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more";

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct Cursor {
    pub offset: u64,
    total: u64,
    basetime: u64,
    feedsource: u64,
    pagenum: u64,
}

pub(crate) struct Page {
    pub history: HistoryMessagePage,
    pub next: Option<Cursor>,
}

fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

fn next_cursor(value: &Value, has_more: bool) -> Result<Option<Cursor>, String> {
    if !has_more {
        return Ok(None);
    }
    let main = value.pointer("/data/main").ok_or("桌面历史缺少分页信息")?;
    let text = main
        .get("externparam")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 4096)
        .ok_or("桌面历史缺少有效分页位置")?;
    let mut fields = std::collections::HashMap::new();
    for (key, value) in url::form_urlencoded::parse(text.as_bytes()) {
        // Never carry advertising cookies, tokens, or arbitrary server fields
        // into a persistent checkpoint or let them override request scope/uin.
        if matches!(key.as_ref(), "offset" | "total" | "basetime" | "feedsource") {
            let value = value.parse::<u64>().map_err(|_| "桌面历史分页位置无效")?;
            if fields.insert(key.into_owned(), value).is_some() {
                return Err("桌面历史包含重复分页字段".into());
            }
        }
    }
    let get = |key: &str| fields.get(key).copied().ok_or("桌面历史分页字段不完整");
    Ok(Some(Cursor {
        offset: get("offset")?,
        total: get("total")?,
        basetime: get("basetime")?,
        feedsource: get("feedsource")?,
        pagenum: main
            .get("pagenum")
            .and_then(number)
            .ok_or("桌面历史缺少页码")?,
    }))
}

fn query(cursor: Option<&Cursor>) -> Vec<(&'static str, String)> {
    let mut query = vec![
        ("scope", "1".into()),
        ("view", "1".into()),
        ("daylist", "".into()),
        ("uinlist", "".into()),
        ("gid", "".into()),
        ("flag", "1".into()),
        ("filter", "all".into()),
        ("applist", "all".into()),
        ("refresh", if cursor.is_some() { "0" } else { "1" }.into()),
        ("aisortEndTime", "0".into()),
        ("aisortOffset", "0".into()),
        ("getAisort", "0".into()),
        ("aisortBeginTime", "0".into()),
        ("firstGetGroup", "0".into()),
        ("icServerTime", "0".into()),
        ("mixnocache", "0".into()),
        ("scene", "0".into()),
        ("pagenum", cursor.map_or(1, |c| c.pagenum).to_string()),
        ("begintime", cursor.map_or(0, |c| c.basetime).to_string()),
        ("count", "10".into()),
        ("dayspac", "5".into()),
        ("sidomain", "qzonestyle.gtimg.cn".into()),
        ("useutf8", "1".into()),
        ("outputhtmlfeed", "1".into()),
        ("format", "jsonp".into()),
    ];
    if let Some(cursor) = cursor {
        let fields = [
            ("offset", cursor.offset.to_string()),
            ("total", cursor.total.to_string()),
            ("basetime", cursor.basetime.to_string()),
            ("feedsource", cursor.feedsource.to_string()),
        ];
        let encoded = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&fields)
            .finish();
        query.extend(fields);
        query.push(("externparam", encoded));
    }
    query
}

fn decode(
    body: &str,
    owner: &str,
    owner_name: Option<&str>,
    cursor: Option<&Cursor>,
) -> Result<Page, String> {
    let value = history_response::object(body)?;
    // A returned -3000 is an auth failure, not an empty history page.
    if value.get("code").and_then(Value::as_i64) == Some(-3000) {
        return Err("QQ_LOGIN_REQUIRED: QQ 登录已失效，请重新登录".into());
    }
    if value.get("code").and_then(Value::as_i64) == Some(-10001)
        && value
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| {
                let message = message.to_ascii_lowercase();
                message.contains("network busy")
                    || message.contains("系统繁忙")
                    || message.contains("请求过于频繁")
                    || message.contains("使用人数过多")
            })
    {
        return Err("QQ_SOURCE_BUSY: QQ 空间历史接口繁忙，已保留断点，请稍后继续恢复".into());
    }
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(format!(
            "桌面历史接口返回错误（{}）",
            value
                .get("code")
                .and_then(Value::as_i64)
                .map_or("未知".into(), |code| code.to_string())
        ));
    }
    let history = decode_history_page(body, owner, owner_name, 0)?;
    let has_more = history
        .has_more
        .ok_or("桌面历史未说明是否还有记录，已保留断点")?;
    let next = next_cursor(&value, has_more)?;
    if next
        .as_ref()
        .zip(cursor)
        .is_some_and(|(next, current)| next == current)
    {
        return Err("桌面历史未推进分页位置，已保留断点；请稍后继续恢复".into());
    }
    Ok(Page { history, next })
}

pub(crate) async fn fetch(
    state: &QLoginState,
    expected_owner: &str,
    cursor: Option<&Cursor>,
    owner_name: Option<&str>,
) -> Result<Page, String> {
    let auth = state.qzone_auth().await?;
    if auth.uin != expected_owner {
        return Err("QQ 登录账号已切换，请停止当前任务后重新开始".into());
    }
    let mut params = query(cursor);
    params.push(("uin", auth.uin.clone()));
    params.push(("g_tk", auth.g_tk.to_string()));
    let response = state
        .client()
        .get(URL)
        .query(&params)
        .header(reqwest::header::COOKIE, &auth.desktop_cookie_header)
        .header(reqwest::header::USER_AGENT, &auth.user_agent)
        .header(reqwest::header::REFERER, "https://user.qzone.qq.com/")
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/javascript, */*;q=0.8",
        )
        .send()
        .await
        .map_err(|_| "桌面历史请求未完成，请检查网络后重试")?;
    let status = response.status();
    let bytes = crate::media_http::bounded_body(response, 4 * 1024 * 1024).await?;
    let body = decode_history_response(&bytes)?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("QQ_LOGIN_REQUIRED: QQ 登录已失效，请重新登录".into());
    }
    if super::is_tencent_waf_response(status, &body) {
        return Err("QQ_REQUEST_BLOCKED: 桌面历史请求被 QQ 空间拦截（HTTP 501）".into());
    }
    if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    ) {
        return Err("DESKTOP_HISTORY_UNSUPPORTED".into());
    }
    if !status.is_success() {
        return Err(format!("桌面历史请求失败：HTTP {status}"));
    }
    decode(&body, &auth.uin, owner_name, cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(cursor: &str, more: bool) -> String {
        json!({"code":0,"subcode":0,"data":{"main":{"pagenum":"2","hasMoreFeeds":more,"externparam":cursor,"total_number":0},"html":"<ul></ul>","data":[]}}).to_string()
    }
    #[test]
    fn carries_server_cursor_without_advertising_or_auth_fields() {
        let cursor = next_cursor(&serde_json::from_str(&response("offset=10&total=8&basetime=1700000000&feedsource=0&gdtadvcookie=private&g_tk=secret&scope=0", true)).unwrap(), true).unwrap().unwrap();
        let params = query(Some(&cursor));
        assert!(params.contains(&("scope", "1".into())));
        assert!(params.contains(&("pagenum", "2".into())));
        assert!(params.contains(&("begintime", "1700000000".into())));
        let encoded = params
            .iter()
            .find(|(k, _)| *k == "externparam")
            .unwrap()
            .1
            .as_str();
        assert_eq!(
            encoded,
            "offset=10&total=8&basetime=1700000000&feedsource=0"
        );
        let stored = serde_json::to_string(&cursor).unwrap();
        assert!(!stored.contains("private") && !stored.contains("secret"));
    }
    #[test]
    fn does_not_turn_auth_errors_or_missing_pagination_into_empty_success() {
        assert!(decode(r#"_Callback({code:-3000});"#, "10001", None, None)
            .err()
            .unwrap()
            .starts_with("QQ_LOGIN_REQUIRED:"));
        for text in [
            r#"{"code":0,"data":{"main":{"hasMoreFeeds":true},"html":"<ul></ul>"}}"#,
            r#"{"code":0,"data":{"html":"<ul></ul>"}}"#,
        ] {
            assert!(decode(text, "10001", None, None).is_err());
        }
        assert!(decode(&response("", false), "10001", None, None)
            .unwrap()
            .next
            .is_none());
    }
    #[test]
    fn rejects_repeated_or_malformed_cursors() {
        let text = response("offset=10&total=8&basetime=1&feedsource=0", true);
        let cursor = next_cursor(&serde_json::from_str(&text).unwrap(), true)
            .unwrap()
            .unwrap();
        assert!(decode(&text, "10001", None, Some(&cursor))
            .err()
            .unwrap()
            .contains("未推进分页"));
        for cursor in [
            "offset=10&offset=20&total=8&basetime=1&feedsource=0",
            "offset=no&total=8&basetime=1&feedsource=0",
            "offset=10",
        ] {
            assert!(next_cursor(
                &serde_json::from_str(&response(cursor, true)).unwrap(),
                true
            )
            .is_err());
        }
    }

    #[test]
    fn busy_is_not_an_auth_failure_or_an_empty_page() {
        let error = decode(
            r#"_Callback({code:-10001,subcode:-30,message:'network busy'});"#,
            "10001",
            None,
            None,
        )
        .err()
        .unwrap();
        assert!(error.starts_with("QQ_SOURCE_BUSY:"));
        assert!(!super::super::qq_login_required(&error));
        let unknown = decode(
            r#"_Callback({code:-10001,message:'other error'});"#,
            "10001",
            None,
            None,
        )
        .err()
        .unwrap();
        assert!(!unknown.starts_with("QQ_SOURCE_BUSY:"));
    }

    #[test]
    fn personal_history_does_not_import_a_friends_post_with_the_same_name() {
        let fragment = |uin: &str| {
            format!(
                r#"<li class="f-single f-s-s" data-key="fct_20001_217_3_1445097600_1"><p class="txt-box-title"><a class="q_namecard" link="nameCard_{uin}">同名用户</a>的说说：2015 年的历史正文</p></li>"#
            )
        };
        for (uin, expected) in [("10001", 1), ("30001", 0)] {
            let body=json!({"code":0,"data":{"main":{"hasMoreFeeds":false},"data":[{"html":fragment(uin)},null]}}).to_string();
            let page = decode(&body, "10001", Some("同名用户"), None).unwrap();
            assert_eq!(page.history.feeds.len(), expected);
            if expected == 1 {
                assert_eq!(
                    page.history.feeds[0]["original"]["cell_summary"]["summary"],
                    "2015 年的历史正文"
                );
            }
        }
    }
}
