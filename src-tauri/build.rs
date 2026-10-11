//! 构建脚本：生成部署常量。
//!
//! 除了调用 `tauri-build`，它还把四项部署配置（授权服务器地址、内置验签公钥、
//! 更新清单地址、官网下载页）从配置文件读出来，生成 `qza_config.rs` 交给 `lib.rs`。
//!
//! 之所以不再写死在源码里：公开仓库需要能被任何人构建，但公开源码不该包含生产
//! 服务地址与生产验签公钥。写死会出现两种坏结果 —— 要么公开仓库里的地址是假的、
//! 照着它构建出来的客户端无法激活；要么真实地址进了公开仓库。拆成配置文件后，
//! 公开仓库带的是占位值，真实值只留在打包机上。
//!
//! 取值优先级（高到低）：
//!   1. 编译期环境变量，例如 `QZA_LICENSE_SERVER`
//!   2. `qza.config.local.json`（不入库，放真实部署值）
//!   3. `qza.config.json`（入库，占位值）
//!
//! 四级全部落到占位值时，生成的 `CONFIG_IS_PLACEHOLDER` 为 true。客户端据此把
//! 「本构建未配置授权服务器」变成一句明确提示 —— 占位地址下的激活请求永远失败，
//! 静默下去用户只会看到笼统的网络错误。

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// 占位配置。入库，随仓库分发。
const CONFIG: &str = "qza.config.json";
/// 本机配置。不入库，只存在于打包机上。
const LOCAL_CONFIG: &str = "qza.config.local.json";

/// 参与配置的键，顺序即生成文件里的顺序。
const KEYS: [&str; 4] = [
    "QZA_LICENSE_SERVER",
    "QZA_LICENSE_PUBLIC_KEY",
    "QZA_UPDATE_ENDPOINT",
    "QZA_DOWNLOAD_PAGE",
];

/// 读取一份配置文件。
///
/// 下划线开头的键（例如 `_comment`）是给人看的说明，跳过；其余键必须是字符串。
/// 这里先反序列化成 `serde_json::Value` 而不是直接取 `BTreeMap<String, String>`，
/// 就是为了让说明可以写成数组，而不必硬挤进一个字符串里。
fn read_config(path: &str) -> Option<BTreeMap<String, String>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => panic!("读取 {path} 失败：{error}"),
    };
    let parsed: BTreeMap<String, serde_json::Value> = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("{path} 不是合法的 JSON 对象：{error}"));

    let mut out = BTreeMap::new();
    for (key, value) in parsed {
        if key.starts_with('_') {
            continue;
        }
        match value.as_str() {
            Some(text) => {
                out.insert(key, text.to_owned());
            }
            None => panic!("{path} 的 {key} 必须是字符串"),
        }
    }
    Some(out)
}

/// 把任意字符串转成 Rust 字面量。手写转义容易漏掉反斜杠，这里一次做对。
fn rust_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// 判据用**值**而不是来源：把随仓库分发的占位值原样抄进 `qza.config.local.json`
/// 也一样是占位值，而只看来源的实现会把它当成「已配置」放行。
fn is_placeholder(placeholder: &BTreeMap<String, String>, key: &str, value: &str) -> bool {
    placeholder.get(key).is_some_and(|shipped| shipped == value)
}

/// 三项地址必须是 http(s) 绝对地址。打包机上写个 `qza-api.example.com`（少了协议）
/// 或相对路径都会让运行时拼出废地址，而这种错在构建期完全能看出来。
fn is_absolute_http_url(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("https://") || value.starts_with("http://")
}

/// 校验内置验签公钥：必须是 base64（标准或 URL-safe，允许缺省 padding）解出来
/// 恰好 32 字节的 Ed25519 公钥。
///
/// 只判「非空」是不够的 —— 长度不对的公钥会让每一次签名校验都失败，而客户端只会
/// 笼统地报「激活失败」，排查要一路查回打包机。这里在构建期直接拦下。
fn is_ed25519_public_key(value: &str) -> bool {
    let trimmed = value.trim();
    let mut bytes = 0_usize;
    // 已累积的 base64 字符数（每次满 4 个出 3 字节）。
    let mut count = 0_usize;
    for ch in trimmed.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '-' | '/' | '_' => {
                count += 1;
                if count == 4 {
                    bytes += 3;
                    count = 0;
                }
            }
            // padding 之后不该再有数据字符；缺省 padding 也接受。
            '=' => break,
            _ => return false,
        }
    }
    match count {
        0 => {}
        2 => bytes += 1,
        3 => bytes += 2,
        // 只剩 1 个字符无法构成任何 base64 字节。
        _ => return false,
    }
    bytes == 32
}

fn main() {
    println!("cargo:rerun-if-changed={CONFIG}");
    if Path::new(LOCAL_CONFIG).exists() {
        println!("cargo:rerun-if-changed={LOCAL_CONFIG}");
    }
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    println!("cargo:rerun-if-env-changed=QZA_REQUIRE_CONFIG");

    let placeholder = read_config(CONFIG)
        .unwrap_or_else(|| panic!("缺少 {CONFIG} —— 占位配置应当随仓库一起提供"));
    let local = read_config(LOCAL_CONFIG);

    let mut resolved: Vec<(&str, String)> = Vec::with_capacity(KEYS.len());
    let mut sources: Vec<String> = Vec::with_capacity(KEYS.len());
    let mut all_placeholder = true;

    for key in KEYS {
        let from_env = env::var(key).ok().filter(|value| !value.trim().is_empty());
        let from_local = local
            .as_ref()
            .and_then(|map| map.get(key))
            .filter(|value| !value.trim().is_empty())
            .cloned();

        let (value, source) = match (from_env, from_local) {
            (Some(value), _) => (value, "环境变量".to_owned()),
            (None, Some(value)) => (value, LOCAL_CONFIG.to_owned()),
            (None, None) => {
                let value = placeholder
                    .get(key)
                    .cloned()
                    .unwrap_or_else(|| panic!("{CONFIG} 缺少 {key}"));
                (value, "占位值".to_owned())
            }
        };

        if !is_placeholder(&placeholder, key, &value) {
            all_placeholder = false;
        }
        sources.push(source);
        resolved.push((key, value));
    }

    // 真实构建保持安静，占位构建每个 key 都说清楚来源，否则打包机的配置漂移没人会发现。
    if all_placeholder {
        println!(
            "cargo:warning=部署配置全部为占位值（{}）—— 本构建无法激活，也不会提示更新。\
             请提供 {LOCAL_CONFIG} 或设置对应环境变量。",
            CONFIG
        );
        for (key, source) in KEYS.iter().zip(sources.iter()) {
            println!("cargo:warning=  {key} 来自{source}");
        }
    } else {
        for (key, source) in KEYS.iter().zip(sources.iter()) {
            println!("cargo:warning={key} 来自{source}");
        }
    }

    // 发布流水线设 `QZA_REQUIRE_CONFIG=1`：缺配置就直接失败，而不是安静地产出
    // 一批指向 `license.example.com`、装上也激活不了的安装包。公开源码里没有
    // 真实值，谁 clone 下来直接构建都会落到占位值，所以这个开关必须由 CI 显式打开。
    //
    // 校验是**逐项**的，不看「四项是否全部为占位值」：只配了其中一项时，旧的
    // `all_placeholder` 判据已经是 false，构建会一路通过，产出的包却有三项仍指向
    // 占位地址 —— 装上去激活不了、更新也拉不到，而且这种包与正常包外观完全一样。
    // 所以每项都要单独过：占位值一律拒绝，三项地址必须是 http(s) 绝对地址，
    // 公钥必须是 32 字节的 base64 Ed25519 公钥。
    if env::var("QZA_REQUIRE_CONFIG").is_ok_and(|flag| !matches!(flag.trim(), "" | "0")) {
        let mut problems: Vec<String> = Vec::new();
        for ((key, value), source) in resolved.iter().zip(sources.iter()) {
            let key: &str = key;
            if is_placeholder(&placeholder, key, value.as_str()) {
                problems.push(format!("{key} 仍是占位值（来自{source}）"));
                continue;
            }
            if key == "QZA_LICENSE_PUBLIC_KEY" {
                if !is_ed25519_public_key(value) {
                    problems.push(format!(
                        "QZA_LICENSE_PUBLIC_KEY 不是 32 字节的 base64 Ed25519 公钥（来自{source}）"
                    ));
                }
            } else if !is_absolute_http_url(value) {
                problems.push(format!(
                    "{key} 不是 http(s) 绝对地址（来自{source}）：{value}"
                ));
            }
        }
        if !problems.is_empty() {
            panic!(
                "QZA_REQUIRE_CONFIG 已开启，但部署配置不完整（{} 项有问题）：\n  - {}\n\
                 四项都必须给出真实值：QZA_LICENSE_SERVER / QZA_LICENSE_PUBLIC_KEY / \
                 QZA_UPDATE_ENDPOINT / QZA_DOWNLOAD_PAGE，或提供 {LOCAL_CONFIG}。",
                problems.len(),
                problems.join("\n  - ")
            );
        }
    }

    let mut generated = String::from(
        "// @generated by build.rs —— 不要手改。改 qza.config.json 或 qza.config.local.json。\n\n",
    );
    generated.push_str("/// 四项部署常量是否全部来自占位配置。公开源码直接构建时为 true。\n");
    generated.push_str(&format!(
        "pub const CONFIG_IS_PLACEHOLDER: bool = {all_placeholder};\n\n"
    ));
    for ((key, value), source) in resolved.iter().zip(sources.iter()) {
        generated.push_str(&format!(
            "/// 来自{source}。\npub const {}: &str = {};\n\n",
            key,
            rust_string_literal(value)
        ));
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR 未设置"));
    fs::write(out_dir.join("qza_config.rs"), generated).expect("写入 qza_config.rs 失败");

    tauri_build::build()
}
