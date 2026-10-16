// Explicit, ignored network diagnosis for the current user's QQ session.
// No cookies, tokens, URLs with query strings, or response bodies are emitted.
// This module is never compiled into production builds.

#[tokio::test]
#[ignore = "explicit opt-in; at most three pages with one busy retry each (six requests), no writes"]
async fn verify_production_desktop_history_without_private_output() {
    assert_eq!(
        std::env::var("QZA_DIAGNOSE_SAVED_SESSION").as_deref(),
        Ok("1")
    );
    let state = crate::qlogin::QLoginState::new();
    let owner = state
        .qzone_auth()
        .await
        .expect("saved session required")
        .uin;
    let mut cursor = None;
    let mut events = std::collections::HashSet::new();
    for index in 0..3 {
        let result = super::desktop_history::fetch(&state, &owner, cursor.as_ref(), None).await;
        let result = if result
            .as_ref()
            .is_err_and(|e| e.starts_with("QQ_SOURCE_BUSY:"))
        {
            eprintln!(
                "QQ_DIAG production_desktop page={} busy_wait_seconds=45",
                index + 1
            );
            tokio::time::sleep(std::time::Duration::from_secs(45)).await;
            super::desktop_history::fetch(&state, &owner, cursor.as_ref(), None).await
        } else {
            result
        };
        let page = match result {
            Ok(page) => page,
            Err(error) => {
                for marker in [
                    "桌面历史接口返回错误",
                    "桌面历史缺少页码",
                    "未推进分页位置",
                    "历史消息包含记录",
                    "无法确认本人昵称",
                    "分页字段不完整",
                    "历史消息响应格式无法识别",
                    "历史消息缺少有效响应",
                    "桌面历史未说明",
                    "桌面历史请求未完成",
                    "桌面历史请求失败",
                ] {
                    if error.contains(marker) {
                        eprintln!("QQ_DIAG production_failure_kind={marker}");
                    }
                }
                if error.starts_with("桌面历史接口返回错误") {
                    let code = regex::Regex::new(r"-?\d+")
                        .unwrap()
                        .find(&error)
                        .map(|m| m.as_str());
                    eprintln!("QQ_DIAG production_business_code={code:?}");
                }
                eprintln!(
                    "QQ_DIAG production_desktop page={} success=false auth_failure={} waf={} busy={}",
                    index + 1,
                    super::qq_login_required(&error),
                    super::feed_error_is_waf_block(&error),
                    error.starts_with("QQ_SOURCE_BUSY:")
                );
                panic!(
                    "production desktop history page did not validate; no response content logged"
                );
            }
        };
        let mut new_events = 0;
        let mut before_2018 = 0;
        for feed in &page.history.feeds {
            if let Some(key) = feed
                .pointer("/comm/feedskey")
                .and_then(serde_json::Value::as_str)
            {
                if events.insert(key.to_owned()) {
                    new_events += 1;
                }
            }
            if feed
                .pointer("/comm/time")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|t| t > 0 && t < 1_514_764_800)
            {
                before_2018 += 1;
            }
        }
        eprintln!("QQ_DIAG production_desktop page={} success=true cards={} attributed={} new_events={new_events} before_2018={before_2018} more={}", index+1, page.history.record_count, page.history.feeds.len(),page.next.is_some());
        assert!(
            page.history.feeds.is_empty() || new_events > 0,
            "desktop history repeated the preceding page"
        );
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

#[tokio::test]
#[ignore = "explicit opt-in; one bounded desktop feed request, no private output"]
async fn diagnose_desktop_feeds3_without_exposing_credentials() {
    assert_eq!(
        std::env::var("QZA_DIAGNOSE_SAVED_SESSION").as_deref(),
        Ok("1")
    );
    let state = crate::qlogin::QLoginState::new();
    let Ok(auth) = state.qzone_auth().await else {
        eprintln!("QQ_DIAG saved_session=unavailable");
        return;
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap();
    let response = client.get("https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more")
        .query(&[("uin", auth.uin.as_str()), ("scope", "0"), ("view", "1"),
            ("daylist", ""), ("uinlist", ""), ("gid", ""), ("flag", "1"),
            ("filter", "all"), ("applist", "all"), ("refresh", "1"),
            ("pagenum", "0"), ("begintime", "0"), ("dayspac", "5"),
            ("sidomain", "qzonestyle.gtimg.cn"), ("useutf8", "1"),
            ("outputhtmlfeed", "1"), ("format", "jsonp"),
            ("g_tk", &auth.g_tk.to_string())])
        .header(reqwest::header::COOKIE, &auth.desktop_cookie_header)
        .header(reqwest::header::USER_AGENT, &auth.user_agent)
        .header(reqwest::header::REFERER, "https://user.qzone.qq.com/")
        .send().await;
    match response {
        Ok(response) => {
            let status = response.status();
            if let Ok(bytes) = crate::media_http::bounded_body(response, 4 * 1024 * 1024).await {
                let body = String::from_utf8_lossy(&bytes);
                // This endpoint returns a JavaScript object literal. The generic
                // strict JSON extractor can select a nested object instead.
                // Decode as data, never execute QQ's response as JavaScript.
                match crate::history_response::decode(&body) {
                    Ok(page) => eprintln!(
                        "QQ_DIAG desktop_decode html_bytes={} entry_count={:?} has_more={:?}",
                        page.html.len(),
                        page.entry_count,
                        page.has_more
                    ),
                    Err(_) => eprintln!("QQ_DIAG desktop_decode=unavailable"),
                }
                eprintln!(
                    "QQ_DIAG endpoint=desktop-feeds3 status={} waf={}",
                    status.as_u16(),
                    super::is_tencent_waf_response(status, &body)
                );
            }
        }
        Err(_) => eprintln!("QQ_DIAG endpoint=desktop-feeds3 transport=failed"),
    }
}

#[tokio::test]
#[ignore = "explicit opt-in; four small read-only Cookie-shape controls, no secret output"]
async fn diagnose_cookie_identity_shape_without_exposing_values() {
    assert_eq!(
        std::env::var("QZA_DIAGNOSE_SAVED_SESSION").as_deref(),
        Ok("1")
    );
    let state = crate::qlogin::QLoginState::new();
    let Ok(auth) = state.qzone_auth().await else {
        eprintln!("QQ_DIAG saved_session=unavailable");
        return;
    };
    let cookies = auth
        .desktop_cookie_header
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .collect::<std::collections::HashMap<_, _>>();
    let Some(identity) = cookies.get("uin") else {
        return;
    };
    let numeric = auth.uin.parse::<u64>().unwrap_or(0);
    eprintln!(
        "QQ_DIAG identity_matches_unpadded={} identity_matches_padded={} cookie_octets_valid={}",
        *identity == format!("o{}", auth.uin),
        *identity == format!("o{numeric:010}"),
        cookies.values().all(|v| v
            .bytes()
            .all(|b| b > 0x20 && b < 0x7f && !matches!(b, b'"' | b',' | b';' | b'\\')))
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    for (label, header) in [
        ("generic", "test=1".to_owned()),
        ("identity", format!("uin={identity}")),
        ("domain-identity", format!("p_uin={identity}")),
        ("placeholder-identity", "uin=o0000000000".to_owned()),
    ] {
        if let Ok(response) = client
            .get(super::HISTORY_MESSAGES_URL)
            .query(&[("format", "jsonp"), ("offset", "0"), ("count", "1")])
            .header(reqwest::header::COOKIE, header)
            .header(reqwest::header::USER_AGENT, &auth.user_agent)
            .header(reqwest::header::REFERER, "https://user.qzone.qq.com/")
            .send()
            .await
        {
            let status = response.status();
            if let Ok(bytes) = crate::media_http::bounded_body(response, 1024 * 1024).await {
                let body = String::from_utf8_lossy(&bytes);
                eprintln!(
                    "QQ_DIAG cookie_shape={label} status={} waf={}",
                    status.as_u16(),
                    super::is_tencent_waf_response(status, &body)
                );
            }
        }
    }
}

#[tokio::test]
#[ignore = "explicit local diagnosis only; makes up to eleven bounded read-only requests using the saved QQ session"]
async fn diagnose_saved_session_http_status_without_exposing_credentials() {
    assert_eq!(
        std::env::var("QZA_DIAGNOSE_SAVED_SESSION").as_deref(),
        Ok("1"),
        "explicit diagnostic opt-in required"
    );
    let state = crate::qlogin::QLoginState::new();
    let auth = match state.qzone_auth().await {
        Ok(auth) => auth,
        Err(_) => {
            eprintln!("QQ_DIAG saved_session=unavailable");
            return;
        }
    };
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let quote = |value: &str| {
            format!(
                "\"{}\"",
                value
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\r', "\\r")
                    .replace('\n', "\\n")
            )
        };
        let url = reqwest::Url::parse_with_params(
            super::HISTORY_MESSAGES_URL,
            &[
                ("uin", auth.uin.clone()),
                ("format", "jsonp".into()),
                ("offset", "0".into()),
                ("count", "1".into()),
                ("g_tk", auth.g_tk.to_string()),
            ],
        )
        .expect("fixed diagnostic URL");
        let config = format!(
            "url = {}\nheader = {}\nheader = {}\nuser-agent = {}\n",
            quote(url.as_str()),
            quote(&format!("Cookie: {}", auth.desktop_cookie_header)),
            quote("Referer: https://user.qzone.qq.com/"),
            quote(&auth.user_agent)
        );
        let executable =
            std::path::PathBuf::from(std::env::var_os("WINDIR").expect("Windows directory"))
                .join("System32/curl.exe");
        if let Ok(mut child) = std::process::Command::new(executable)
            .args([
                "-q",
                "--config",
                "-",
                "--silent",
                "--max-time",
                "15",
                "--max-filesize",
                "4194304",
                "--noproxy",
                "*",
                "--write-out",
                "\nQZA_STATUS:%{http_code}",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(config.as_bytes());
            }
            if let Ok(output) = child.wait_with_output() {
                let body = String::from_utf8_lossy(&output.stdout);
                let status = body
                    .rsplit_once("\nQZA_STATUS:")
                    .map(|(_, status)| status.trim())
                    .filter(|status| {
                        status.len() == 3 && status.bytes().all(|b| b.is_ascii_digit())
                    })
                    .unwrap_or("unknown");
                let api_code =
                    super::parse_qzone_json(body.split("\nQZA_STATUS:").next().unwrap_or(""))
                        .ok()
                        .and_then(|value| value.get("code").and_then(serde_json::Value::as_i64));
                eprintln!("QQ_DIAG endpoint=history route=direct client=schannel status={status} waf={} api_code={api_code:?}",body.contains("waf.tencent.com"));
            }
        }
    }
    for direct in [false, true] {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(15));
        if direct {
            builder = builder.no_proxy();
        }
        let client = builder.build().expect("diagnostic client configuration");
        if direct {
            let cookies = auth
                .desktop_cookie_header
                .split(';')
                .filter_map(|part| part.trim().split_once('='))
                .collect::<std::collections::HashMap<_, _>>();
            for (label, names, key) in [
                (
                    "core-session",
                    vec!["uin", "skey", "p_uin", "p_skey"],
                    "p_skey",
                ),
                ("skey-session", vec!["uin", "skey"], "skey"),
                ("pskey-session", vec!["uin", "p_uin", "p_skey"], "p_skey"),
            ] {
                let header = names
                    .iter()
                    .filter_map(|name| cookies.get(name).map(|value| format!("{name}={value}")))
                    .collect::<Vec<_>>()
                    .join("; ");
                let Some(key) = cookies.get(key) else {
                    continue;
                };
                let token = key.bytes().fold(5381u32, |hash, byte| {
                    hash.wrapping_mul(33).wrapping_add(byte as u32)
                }) & 0x7fff_ffff;
                let query = vec![
                    ("uin", auth.uin.clone()),
                    ("format", "jsonp".to_owned()),
                    ("offset", "0".into()),
                    ("count", "1".into()),
                    ("g_tk", token.to_string()),
                ];
                if let Ok(response) = client
                    .get(super::HISTORY_MESSAGES_URL)
                    .query(&query)
                    .header(reqwest::header::USER_AGENT, &auth.user_agent)
                    .header(reqwest::header::REFERER, "https://user.qzone.qq.com/")
                    .header(reqwest::header::COOKIE, header)
                    .send()
                    .await
                {
                    let status = response.status();
                    if let Ok(bytes) =
                        crate::media_http::bounded_body(response, 4 * 1024 * 1024).await
                    {
                        let body = String::from_utf8_lossy(&bytes);
                        let code = super::parse_qzone_json(&body)
                            .ok()
                            .and_then(|v| v.get("code").and_then(serde_json::Value::as_i64));
                        eprintln!("QQ_DIAG endpoint=history route=direct session={label} status={} waf={} api_code={code:?}",status.as_u16(),super::is_tencent_waf_response(status,&body));
                    }
                }
            }
        }
        if direct {
            for (label, cookie, token) in
                [("cookie-only", true, false), ("token-only", false, true)]
            {
                let mut query = vec![
                    ("format", "jsonp".to_owned()),
                    ("offset", "0".into()),
                    ("count", "1".into()),
                ];
                if token {
                    query.push(("g_tk", auth.g_tk.to_string()));
                    query.push(("uin", auth.uin.clone()));
                }
                let mut request = client
                    .get(super::HISTORY_MESSAGES_URL)
                    .query(&query)
                    .header(reqwest::header::USER_AGENT, &auth.user_agent)
                    .header(reqwest::header::REFERER, "https://user.qzone.qq.com/");
                if cookie {
                    request = request.header(reqwest::header::COOKIE, &auth.desktop_cookie_header);
                }
                if let Ok(response) = request.send().await {
                    let status = response.status();
                    if let Ok(bytes) =
                        crate::media_http::bounded_body(response, 4 * 1024 * 1024).await
                    {
                        let body = String::from_utf8_lossy(&bytes);
                        eprintln!("QQ_DIAG endpoint=history route=direct session={label} status={} waf={}",status.as_u16(),super::is_tencent_waf_response(status,&body));
                    }
                }
            }
        }
        if direct {
            // Anonymous control separates transport behavior from account/cookie behavior.
            match client
                .get(super::HISTORY_MESSAGES_URL)
                .query(&[("format", "jsonp"), ("offset", "0"), ("count", "1")])
                .header(reqwest::header::USER_AGENT, &auth.user_agent)
                .header(reqwest::header::REFERER, "https://user.qzone.qq.com/")
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    if let Ok(bytes) =
                        crate::media_http::bounded_body(response, 4 * 1024 * 1024).await
                    {
                        let body = String::from_utf8_lossy(&bytes);
                        eprintln!("QQ_DIAG endpoint=history route=direct session=anonymous status={} waf={}",status.as_u16(),super::is_tencent_waf_response(status,&body));
                    }
                }
                Err(_) => eprintln!(
                    "QQ_DIAG endpoint=history route=direct session=anonymous transport=failed"
                ),
            }
        }
        for history in [true, false] {
            let (url, cookie, referer, query) = if history {
                (
                    super::HISTORY_MESSAGES_URL,
                    auth.desktop_cookie_header.as_str(),
                    format!("https://user.qzone.qq.com/{}/main", auth.uin),
                    vec![
                        ("uin", auth.uin.clone()),
                        ("begin_time", "0".into()),
                        ("end_time", "0".into()),
                        ("getappnotification", "1".into()),
                        ("getnotifi", "1".into()),
                        ("has_get_key", "0".into()),
                        ("offset", "0".into()),
                        ("set", "0".into()),
                        ("count", "1".into()),
                        ("useutf8", "1".into()),
                        ("outputhtmlfeed", "1".into()),
                        ("scope", "1".into()),
                        ("format", "jsonp".into()),
                        ("g_tk", auth.g_tk.to_string()),
                    ],
                )
            } else {
                (
                    super::FEEDS_URL,
                    auth.cookie_header.as_str(),
                    "https://h5.qzone.qq.com/".into(),
                    vec![
                        ("g_tk", auth.g_tk.to_string()),
                        ("res_type", "1".into()),
                        ("refresh_type", "1".into()),
                        ("format", "json".into()),
                    ],
                )
            };
            let mut request = client
                .get(url)
                .query(&query)
                .header(reqwest::header::COOKIE, cookie)
                .header(reqwest::header::USER_AGENT, &auth.user_agent)
                .header(reqwest::header::REFERER, referer)
                .header(
                    reqwest::header::ACCEPT,
                    if history {
                        "application/json, text/javascript, */*;q=0.8"
                    } else {
                        "application/json"
                    },
                )
                .header(reqwest::header::CACHE_CONTROL, "no-cache")
                .header(reqwest::header::PRAGMA, "no-cache")
                .header("Sec-Fetch-Dest", "empty")
                .header("Sec-Fetch-Mode", "cors")
                .header(
                    "Sec-Fetch-Site",
                    if history { "same-origin" } else { "same-site" },
                );
            if !history {
                request = request.header(reqwest::header::ORIGIN, "https://h5.qzone.qq.com");
            }
            let endpoint = if history { "history" } else { "interactions" };
            let route = if direct { "direct" } else { "environment" };
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    match crate::media_http::bounded_body(response, 4 * 1024 * 1024).await {
                        Ok(bytes) => {
                            let body = String::from_utf8_lossy(&bytes);
                            let api_code = super::parse_qzone_json(&body).ok().and_then(|value| {
                                value.get("code").and_then(serde_json::Value::as_i64)
                            });
                            eprintln!("QQ_DIAG endpoint={endpoint} route={route} status={} waf={} api_code={api_code:?}",status.as_u16(),super::is_tencent_waf_response(status,&body));
                        }
                        Err(_) => {
                            eprintln!("QQ_DIAG endpoint={endpoint} route={route} body=unavailable")
                        }
                    }
                }
                Err(_) => {
                    eprintln!("QQ_DIAG endpoint={endpoint} route={route} transport=failed")
                }
            }
        }
    }
}
