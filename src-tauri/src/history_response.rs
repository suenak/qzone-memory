//! Read QQ's legacy JSONP object literals as data, without executing JavaScript.
use serde_json::Value;
use std::{iter::Peekable, str::Chars};

fn hex(chars: &mut Peekable<Chars<'_>>, count: usize) -> Result<u32, String> {
    let mut value = 0;
    for _ in 0..count {
        value = value * 16
            + chars
                .next()
                .and_then(|c| c.to_digit(16))
                .ok_or("历史消息转义不完整")?;
    }
    Ok(value)
}

fn string(chars: &mut Peekable<Chars<'_>>, quote: char) -> Result<String, String> {
    let mut result = String::new();
    while let Some(c) = chars.next() {
        if c == quote {
            return Ok(result);
        }
        if c != '\\' {
            result.push(c);
            continue;
        }
        let escaped = chars.next().ok_or("历史消息字符串不完整")?;
        match escaped {
            'x' => result.push(char::from_u32(hex(chars, 2)?).ok_or("历史消息转义无效")?),
            'u' => {
                let mut code = hex(chars, 4)?;
                if (0xd800..=0xdbff).contains(&code) {
                    if chars.next() != Some('\\') || chars.next() != Some('u') {
                        return Err("历史消息 Unicode 转义不完整".into());
                    }
                    let low = hex(chars, 4)?;
                    if !(0xdc00..=0xdfff).contains(&low) {
                        return Err("历史消息 Unicode 转义无效".into());
                    }
                    code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                }
                result.push(char::from_u32(code).ok_or("历史消息 Unicode 转义无效")?);
            }
            'n' => result.push('\n'),
            'r' => result.push('\r'),
            't' => result.push('\t'),
            'b' => result.push('\u{8}'),
            'f' => result.push('\u{c}'),
            'v' => result.push('\u{b}'),
            '0' => result.push('\0'),
            '\n' => {}
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            other => result.push(other),
        }
    }
    Err("历史消息字符串不完整".into())
}

fn object(response: &str) -> Result<Value, String> {
    let callback = response
        .find("_Callback")
        .map(|index| &response[index..])
        .unwrap_or(response);
    let start = callback.find('{').ok_or("历史消息缺少有效响应")?;
    let mut chars = callback[start..].chars().peekable();
    let mut normalized = String::new();
    let mut depth = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => normalized.push_str(
                &serde_json::to_string(&string(&mut chars, c)?)
                    .map_err(|_| "历史消息字符串无效")?,
            ),
            '{' | '[' => {
                depth += 1;
                if depth > 64 {
                    return Err("历史消息结构过深".into());
                }
                normalized.push(c);
            }
            '}' | ']' => {
                depth = depth.checked_sub(1).ok_or("历史消息结构不完整")?;
                normalized.push(c);
                if depth == 0 {
                    return serde_json::from_str(&normalized)
                        .map_err(|_| "历史消息响应格式无法识别".into());
                }
            }
            c if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
                let mut name = c.to_string();
                while chars
                    .peek()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                {
                    name.push(chars.next().unwrap());
                }
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
                if chars.peek() == Some(&':') {
                    normalized
                        .push_str(&serde_json::to_string(&name).map_err(|_| "历史消息字段无效")?);
                } else if matches!(name.as_str(), "true" | "false" | "null") {
                    normalized.push_str(&name);
                } else if name == "undefined" {
                    normalized.push_str("null");
                } else {
                    return Err("历史消息包含不支持的表达式".into());
                }
            }
            c if c.is_ascii_digit() || c == '-' => {
                normalized.push(c);
                while chars
                    .peek()
                    .is_some_and(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
                {
                    normalized.push(chars.next().unwrap());
                }
            }
            ',' => {
                // Some legacy responses use trailing commas in object literals.
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
                if !matches!(chars.peek(), Some('}') | Some(']')) {
                    normalized.push(',');
                }
            }
            other => normalized.push(other),
        }
    }
    Err("历史消息响应不完整".into())
}

pub(crate) fn html(response: &str) -> Result<String, String> {
    let value = object(response)?;
    let code = value.get("code").and_then(Value::as_i64);
    for name in ["code", "subcode"] {
        if let Some(status) = value.get(name) {
            let status = status.as_i64().ok_or("历史消息返回了无效的状态码")?;
            if status != 0 {
                return Err(format!("历史消息接口返回错误（{status}）"));
            }
        }
    }
    for parent in [
        &value,
        &value["data"],
        &value["data"]["main"],
        &value["main"],
    ] {
        if let Some(html) = parent.get("html").and_then(Value::as_str) {
            return Ok(html.to_owned());
        }
    }
    // Current legacy endpoints return one HTML fragment per data.data entry.
    // Concatenate decoded fragments, never a greedy span across JSONP records.
    if let Some(entries) = value.pointer("/data/data").and_then(Value::as_array) {
        if !entries.is_empty() {
            let fragments = entries
                .iter()
                // QQ appends an `undefined` sentinel after the real feed entries.
                .filter(|entry| !entry.is_null())
                .map(|entry| entry.get("html").and_then(Value::as_str))
                .collect::<Option<Vec<_>>>()
                .ok_or("部分历史消息缺少可读取的内容")?;
            if fragments.iter().all(|fragment| fragment.trim().is_empty()) {
                return Err("历史消息包含记录，但没有可读取的正文".into());
            }
            return Ok(fragments.join("\n"));
        }
    }
    // Only an explicit successful, empty page can replace a missing html field.
    // Missing fields, an expired session, or a nonempty page remain errors.
    let main = value.pointer("/data/main").or_else(|| value.get("main"));
    if code == Some(0)
        && main.is_some_and(|main| main["hasMoreFeeds"] == false && main["total_number"] == 0)
    {
        return Ok(String::new());
    }
    Err("历史消息响应中缺少可读取的内容".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_the_successful_empty_response_without_html() {
        let response = r#"_Callback({"code":0,"subcode":0,"message":"","default":0,"data":{main:{hasMoreFeeds:false,total_number:0,offset:0,}}});"#;
        assert_eq!(html(response).unwrap(), "");
    }
    #[test]
    fn reads_nested_html_and_decodes_escapes_once() {
        let response = r#"_Callback({code:0,data:{main:{html:'\x3Cp title=\'你好\'\x3E\u4e2d\u6587\ud83d\ude0a\\n\x3C/p\x3E',opuin:'123'}}});"#;
        assert_eq!(html(response).unwrap(), "<p title='你好'>中文😊\\n</p>");
        assert_eq!(
            html(r#"cb({"code":0,"data":{"html":"<p>说说</p>"}});"#).unwrap(),
            "<p>说说</p>"
        );
    }
    #[test]
    fn accepts_legacy_undefined_fields_without_running_expressions() {
        let response = r#"try{_Callback({code:0,data:{main:{html:'<p>正文</p>',optional:undefined,stamp:1.2e+3}},unused:undefined});}catch(e){}"#;
        assert_eq!(html(response).unwrap(), "<p>正文</p>");
    }
    #[test]
    fn reads_every_fragment_in_the_current_history_array() {
        let response = r#"_Callback({code:0,data:{main:{hasMoreFeeds:true,total_number:2},data:[{html:'<li>第一条</li>',opuin:'123',unused:undefined},{html:'<li>第二条</li>',opuin:'456'},undefined]}});"#;
        assert_eq!(html(response).unwrap(), "<li>第一条</li>\n<li>第二条</li>");
        assert!(html(r#"cb({code:0,data:{data:[{html:'first'},{}]}});"#).is_err());
    }
    #[test]
    fn malformed_error_and_nonempty_responses_are_not_empty_pages() {
        for response in [
            r#"cb({code:-3000,data:{main:{hasMoreFeeds:false,total_number:0}}});"#,
            r#"cb({code:0,subcode:1,data:{main:{hasMoreFeeds:false,total_number:0}}});"#,
            r#"cb({code:0,data:{main:{hasMoreFeeds:false,total_number:5}}});"#,
            r#"cb({code:0,data:{main:{hasMoreFeeds:true,total_number:0}}});"#,
            r#"cb({code:0,data:{}});"#,
            r#"cb({code:0,data:{main:execute()}});"#,
            r#"cb({html:'unterminated});"#,
        ] {
            assert!(html(response).is_err(), "{response}");
        }
    }
}
