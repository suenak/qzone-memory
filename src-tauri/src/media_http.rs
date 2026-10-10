//! 媒体地址来自上游数据，不能把地址本身当作发送 QQ 凭证的依据。
use reqwest::{redirect::Policy, Client, RequestBuilder};
use url::Url;

pub fn accepts_qq_credentials(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            ["qq.com", "qpic.cn"]
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        })
}

pub fn media_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value).map_err(|_| "媒体地址无效".to_owned())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("媒体地址不能包含账号信息".to_owned());
    }
    // 旧备份中的 QQ 媒体链接可能使用 HTTP，先升级再发送任何请求。
    if url.scheme() == "http" {
        url.set_scheme("https")
            .map_err(|_| "媒体地址无效".to_owned())?;
        if !accepts_qq_credentials(&url) {
            return Err("媒体地址必须使用 HTTPS".to_owned());
        }
    }
    // host_str() 实测在 url 2.x 下不会返回空串（`https://` 与 `https://:443/a` 直接解析失败），
    // 显式判空是为了让这条防线不依赖 url crate 的具体行为。
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err("媒体地址必须使用 HTTPS".to_owned());
    }
    Ok(url)
}

/// 判断一次重定向是否放行。
/// reqwest 的 `previous()` 保存整条链：**首位是初始 URL，末位才是本次重定向的来源**
/// （reqwest 自身判断跨主重定向时用的也是末位）。取首位会让
/// “起始于 qpic.cn → 第三方” 这类链被当成非凭证来源而放行，显式防线随之失效。
fn redirect_is_allowed(previous: &[Url], destination: &Url) -> bool {
    let credential_origin = previous.last().is_some_and(accepts_qq_credentials);
    destination.scheme() == "https"
        && destination.username().is_empty()
        && destination.password().is_none()
        && !(credential_origin && !accepts_qq_credentials(destination))
}

pub fn redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("媒体重定向次数过多");
        }
        if !redirect_is_allowed(attempt.previous(), attempt.url()) {
            return attempt.error("媒体重定向目标不安全");
        }
        attempt.follow()
    })
}

pub fn request(client: &Client, url: &Url, cookie: &str, with_cookie: bool) -> RequestBuilder {
    let request = client.get(url.clone());
    if with_cookie && accepts_qq_credentials(url) {
        request.header(reqwest::header::COOKIE, cookie)
    } else {
        request
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_require_https_and_a_domain_boundary() {
        for value in [
            "https://qq.com/a",
            "https://img.qq.com/a",
            "https://a.qpic.cn/a",
        ] {
            assert!(accepts_qq_credentials(&Url::parse(value).unwrap()));
        }
        for value in [
            "https://evilqq.com/a",
            "https://evilqpic.cn/a",
            "https://qq.com.evil.test/a",
            "http://img.qq.com/a",
            "https://user@img.qq.com/a",
            "https://example.com/a",
        ] {
            assert!(!accepts_qq_credentials(&Url::parse(value).unwrap()));
        }
    }

    #[test]
    fn legacy_qq_links_are_upgraded_and_other_http_links_rejected() {
        assert_eq!(
            media_url("http://img.qq.com/a?sign=test").unwrap().as_str(),
            "https://img.qq.com/a?sign=test"
        );
        for value in [
            "http://evilqq.com/a",
            "http://example.com/a",
            "file:///a",
            "https://user:pass@qq.com/a",
        ] {
            assert!(media_url(value).is_err());
        }
    }

    #[test]
    fn third_party_redirect_is_rejected_when_the_chain_started_on_qpic() {
        // 起始 qpic.cn：previous 的末位就是 qpic.cn，因此这是凭证来源，第三方目标必须被拒绝。
        let from_qpic = [Url::parse("https://a.qpic.cn/a.jpg").unwrap()];
        let third_party = Url::parse("https://example.com/a.jpg").unwrap();
        assert!(!redirect_is_allowed(&from_qpic, &third_party));
        // 同一来源下的 QQ 域名仍然放行。
        assert!(redirect_is_allowed(
            &from_qpic,
            &Url::parse("https://img.qq.com/a.jpg").unwrap()
        ));
        // 非 QQ 起始则保持原有的宽松行为。
        let from_cdn = [Url::parse("https://cdn.example.com/a.jpg").unwrap()];
        assert!(redirect_is_allowed(&from_cdn, &third_party));
        // 链上有多次跳转时，只有末位（最近一次来源）参与凭证判定。
        let chained = [
            Url::parse("https://a.qpic.cn/a.jpg").unwrap(),
            Url::parse("https://cdn.example.net/b.jpg").unwrap(),
        ];
        assert!(redirect_is_allowed(&chained, &third_party));
        // 目标地址自身携带账号信息时始终拒绝。
        assert!(!redirect_is_allowed(
            &from_qpic,
            &Url::parse("https://user:pass@img.qq.com/a.jpg").unwrap()
        ));
    }

    #[test]
    fn external_media_requests_never_receive_cookie_headers() {
        let client = Client::new();
        for value in [
            "https://evilqq.com/a",
            "https://evilqpic.cn/a",
            "https://example.com/a",
        ] {
            let request = request(&client, &media_url(value).unwrap(), "dummy=test", true)
                .build()
                .unwrap();
            assert!(!request.headers().contains_key(reqwest::header::COOKIE));
        }
        let url = media_url("https://img.qq.com/a").unwrap();
        assert!(request(&client, &url, "dummy=test", true)
            .build()
            .unwrap()
            .headers()
            .contains_key(reqwest::header::COOKIE));
        assert!(!request(&client, &url, "dummy=test", false)
            .build()
            .unwrap()
            .headers()
            .contains_key(reqwest::header::COOKIE));
    }
}
