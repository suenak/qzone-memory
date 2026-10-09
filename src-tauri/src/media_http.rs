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
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("媒体地址必须使用 HTTPS".to_owned());
    }
    Ok(url)
}

pub fn redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        let destination = attempt.url();
        if attempt.previous().len() >= 5 {
            return attempt.error("媒体重定向次数过多");
        }
        let credential_origin = attempt
            .previous()
            .first()
            .is_some_and(accepts_qq_credentials);
        if destination.scheme() != "https"
            || !destination.username().is_empty()
            || destination.password().is_some()
            || (credential_origin && !accepts_qq_credentials(destination))
        {
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
