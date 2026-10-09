//! 授权集成层：设备身份、凭据存储、与服务端通信、命令守卫。
//!
//! 分工原则：
//! - 判定逻辑（验签、时效、防重放）全部在 `license-core`，那里可独立单元测试；
//! - 本模块只做编排与平台适配（凭据库、注册表、文件系统、HTTP）。
//!
//! **本层的校验只服务于体验**（提前提示未激活、支持离线运行），不是安全边界。
//! 真正的边界在服务端：客户端 GPLv3 开源，任何人都能编译出跳过本模块的版本，
//! 但无法伪造服务端签发的凭证，也无法使用需要服务端配合的云能力。

#[cfg(target_os = "android")]
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use license_core::{
    detect_clock_rollback, is_stale_serial, status_for, verify_license, LicenseError,
    LicensePayload, LicenseStatus,
};

/// 编译期可通过 `QZA_LICENSE_SERVER` 注入正式域名；未注入时使用占位地址。
/// 发布前必须替换，否则激活请求会打到不存在的域名。
const LICENSE_SERVER_FALLBACK: &str = "https://license.example.com";

/// 凭据库服务名，与 qlogin.rs 的 QQ 会话共用同一命名空间，但使用不同的 account。
const CREDENTIAL_SERVICE: &str = "top.ehre.qzonearchive";
const CREDENTIAL_DEVICE: &str = "app-license-device";
const CREDENTIAL_LICENSE: &str = "app-license-token";

/// 心跳间隔：24 小时。正常使用频率远低于此。
const HEARTBEAT_INTERVAL_SECONDS: i64 = 24 * 3600;
/// 网络请求超时。
const REQUEST_TIMEOUT_SECONDS: u64 = 20;

pub fn license_server() -> &'static str {
    option_env!("QZA_LICENSE_SERVER").unwrap_or(LICENSE_SERVER_FALLBACK)
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------- 设备身份

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceIdentity {
    pub installation_id: String,
    pub hw_hint: String,
    pub platform: String,
}

impl DeviceIdentity {
    fn create() -> Self {
        Self {
            installation_id: generate_uuid_v4(),
            hw_hint: hardware_hint(),
            platform: current_platform().to_owned(),
        }
    }
}

pub fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "unknown"
    }
}

/// 生成 UUID v4 字符串。使用操作系统熵源，而非项目里那种基于毫秒的伪随机，
/// 因为设备标识即便不是密钥，也不该可预测或在高并发下碰撞。
fn generate_uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // 熵源不可用时退化为时间戳，仍保证格式合法，以免整个激活流程卡死。
        let seed = now_seconds() as u128 ^ (std::process::id() as u128) << 32;
        for (index, slot) in bytes.iter_mut().enumerate() {
            *slot = ((seed >> ((index % 16) * 8)) & 0xFF) as u8;
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// 采集硬件提示值，失败返回空串（协议允许，此时不参与「同机重装」匹配）。
///
/// 注意：**这不是设备主键**。换网卡、重装系统、BIOS 更新都会让它漂移，
/// 用来做主键会把老用户误判成新设备并烧光席位。
fn hardware_hint() -> String {
    match platform_hint() {
        Some(value) if !value.trim().is_empty() => {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(value.trim().as_bytes());
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }
        _ => String::new(),
    }
}

#[cfg(windows)]
fn platform_hint() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        REG_VALUE_TYPE,
    };

    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Cryptography"),
            None,
            KEY_READ,
            &mut key,
        )
        .is_err()
        {
            return None;
        }

        let mut buffer = [0u8; 512];
        let mut size = buffer.len() as u32;
        // REG_VALUE_TYPE 是 newtype 而非裸 u32，必须用它的类型构造。
        let mut value_type = REG_VALUE_TYPE(0);
        let status = RegQueryValueExW(
            key,
            w!("MachineGuid"),
            None,
            Some(&mut value_type),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(key);
        if status.is_err() {
            return None;
        }

        let used = (size as usize).min(buffer.len());
        let units: Vec<u16> = buffer[..used]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let text = String::from_utf16_lossy(&units);
        let trimmed = text.trim_end_matches('\0').trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    }
}

#[cfg(target_os = "linux")]
fn platform_hint() -> Option<String> {
    for path in [
        "/etc/machine-id",
        "/var/lib/dbus/machine-id",
        "/sys/class/dmi/id/product_uuid",
    ] {
        if let Ok(text) = std::fs::read_to_string(path) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn platform_hint() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains("IOPlatformUUID") {
            continue;
        }
        let parts: Vec<&str> = line.split('"').collect();
        if parts.len() >= 4 && parts[1] == "IOPlatformUUID" && !parts[3].is_empty() {
            return Some(parts[3].to_owned());
        }
    }
    None
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn platform_hint() -> Option<String> {
    // Android / iOS：沙箱限制下拿不到稳定且合规的硬件标识，改用 installation_id 作为身份。
    None
}

// ------------------------------------------------------------------ 凭据

/// Android 的 keyring 后端不存在（见 Cargo.toml 的平台分支），
/// 因此移动端把凭据放在应用私有目录：其他应用不可读，卸载即清除。
#[cfg(target_os = "android")]
fn secret_path(app: &tauri::AppHandle, account: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?
        .join("license");
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建许可证目录：{error}"))?;
    Ok(dir.join(format!("{account}.json")))
}

fn read_secret(app: &tauri::AppHandle, account: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let path = secret_path(app, account)?;
        return match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("读取许可证失败：{error}")),
        };
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let entry = keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .map_err(|error| format!("打开系统凭据库失败：{error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取系统凭据失败：{error}")),
        }
    }
}

fn write_secret(app: &tauri::AppHandle, account: &str, value: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let path = secret_path(app, account)?;
        return std::fs::write(&path, value).map_err(|error| format!("保存许可证失败：{error}"));
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .map_err(|error| format!("打开系统凭据库失败：{error}"))?
            .set_password(value)
            .map_err(|error| format!("保存许可证到系统凭据库失败：{error}"))
    }
}

fn delete_secret(app: &tauri::AppHandle, account: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let path = secret_path(app, account)?;
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("清除许可证失败：{error}")),
        };
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let entry = keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .map_err(|error| format!("打开系统凭据库失败：{error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("清除系统凭据失败：{error}")),
        }
    }
}

// ------------------------------------------------------------- 本地许可状态

/// 本地持久化的授权状态。token 本身是签名的，被篡改会在验签时暴露。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredLicense {
    token: String,
    /// 历史最大观察时间，用于识别系统时间回拨。
    #[serde(default)]
    max_seen_time: i64,
    /// 历史最大序列号，用于识别旧凭证重放。
    #[serde(default)]
    max_seen_serial: i64,
    /// 上次成功心跳时间。
    #[serde(default)]
    last_heartbeat: i64,
    /// 服务端返回的账号名，仅用于界面展示。
    #[serde(default)]
    username: String,
}

#[derive(Default)]
struct Runtime {
    identity: Option<DeviceIdentity>,
    license: Option<StoredLicense>,
    payload: Option<LicensePayload>,
    /// 最近一次失败原因，供界面提示。
    last_error: Option<String>,
}

pub struct LicenseState {
    inner: Mutex<Runtime>,
    client: reqwest::Client,
    public_key: Option<[u8; 32]>,
}

static INSTANCE: OnceLock<LicenseState> = OnceLock::new();

impl LicenseState {
    /// 全局单例。
    ///
    /// 授权状态是进程级的单一事实，不该按窗口或按命令传递。做成单例后，
    /// 命令守卫可以零参数调用，43 个既有命令只需各自插入一行，无需改动签名，
    /// 前端 invoke 调用方式也完全不变。
    pub fn global() -> &'static LicenseState {
        INSTANCE.get_or_init(LicenseState::new)
    }

    pub fn new() -> Self {
        let public_key = match license_core::public_key_from_pem(LICENSE_PUBLIC_KEY_PEM) {
            Ok(key) => Some(key),
            Err(error) => {
                eprintln!("[license] 内置公钥解析失败，授权功能不可用: {error}");
                None
            }
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
            .build()
            .unwrap_or_default();
        Self {
            inner: Mutex::new(Runtime::default()),
            client,
            public_key,
        }
    }
}

impl Default for LicenseState {
    fn default() -> Self {
        Self::new()
    }
}

/// 联网备份的访问级别。本地数据访问不使用此判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessLevel {
    /// 完全可用。
    Full,
    /// 已超出宽限期：仅允许查看、搜索、导出既有本地数据，禁止新建归档任务。
    ReadOnly,
}

impl AccessLevel {
    fn allows_archive(self) -> bool {
        matches!(self, Self::Full)
    }
}

fn load_runtime(app: &tauri::AppHandle) -> Runtime {
    let identity = read_secret(app, CREDENTIAL_DEVICE)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<DeviceIdentity>(&text).ok());

    let license = read_secret(app, CREDENTIAL_LICENSE)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<StoredLicense>(&text).ok());

    Runtime {
        identity,
        license,
        payload: None,
        last_error: None,
    }
}

/// 初始化：读取或生成设备身份，并校验本地凭证。
///
/// 时间回拨与旧序列号在此处判定，结果落进 `last_error` 供界面展示。
/// 在 Tauri setup 阶段调用一次，因此命令守卫无需再关心初始化时机。
pub fn initialize(app: &tauri::AppHandle) {
    let state = LicenseState::global();
    let mut runtime = load_runtime(app);

    // hw_hint 每次启动重新采集：它是「installation_id 丢失后找回席位」的唯一线索，
    // 必须反映当前硬件，而不是首次安装时的快照。
    let current_hint = hardware_hint();
    let identity = match runtime.identity.take() {
        Some(mut existing) => {
            existing.hw_hint = current_hint;
            existing
        }
        None => {
            let fresh = DeviceIdentity {
                hw_hint: current_hint,
                ..DeviceIdentity::create()
            };
            if let Ok(text) = serde_json::to_string(&fresh) {
                let _ = write_secret(app, CREDENTIAL_DEVICE, &text);
            }
            fresh
        }
    };

    let now = now_seconds();
    let mut last_error = None;

    if let Some(license) = runtime.license.clone() {
        let max_seen_time = license.max_seen_time.max(now);
        if detect_clock_rollback(now, license.max_seen_time) {
            last_error = Some(LicenseError::ClockRollback.message().to_owned());
        } else if is_stale_serial(0, license.max_seen_serial) {
            // 占位分支不会触发，保留结构以便未来接入多凭证场景。
        }

        match state.public_key {
            Some(key) => match verify_license(&license.token, &key, &identity.installation_id, now)
            {
                Ok(payload) => runtime.payload = Some(payload),
                Err(error) => last_error = Some(error.message().to_owned()),
            },
            None => last_error = Some("内置公钥不可用".to_owned()),
        }

        let mut updated = license;
        updated.max_seen_time = max_seen_time;
        runtime.license = Some(updated);
    }

    runtime.identity = Some(identity);
    runtime.last_error = last_error;

    if let Ok(mut guard) = state.inner.lock() {
        *guard = runtime;
    }
}

// ------------------------------------------------------------------ 视图

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseView {
    /// notActivated | active | grace | restricted | invalid
    pub status: String,
    pub activated: bool,
    pub can_archive: bool,
    pub username: Option<String>,
    pub expires_at: Option<i64>,
    pub usable_until: Option<i64>,
    pub remaining_days: Option<i64>,
    /// 账号允许的设备席位数，0 表示未知（旧凭证）。
    pub max_seats: i64,
    pub features: Vec<String>,
    pub installation_id: Option<String>,
    pub platform: String,
    pub server: String,
    pub message: Option<String>,
}

fn view_from(runtime: &Runtime, server: &str) -> LicenseView {
    let now = now_seconds();
    let platform = runtime
        .identity
        .as_ref()
        .map(|identity| identity.platform.clone())
        .unwrap_or_else(|| current_platform().to_owned());
    let installation_id = runtime
        .identity
        .as_ref()
        .map(|identity| identity.installation_id.clone());

    match runtime.payload.as_ref() {
        Some(payload) => {
            let status = status_for(payload, now);
            let (status_name, can_archive, message) = match status {
                LicenseStatus::Active => ("active", true, None),
                LicenseStatus::Grace => (
                    "grace",
                    true,
                    Some(format!(
                        "已进入离线宽限期，请在 {} 天内部署网络以续期。",
                        payload.remaining_seconds(now).max(0) / 86_400
                    )),
                ),
                LicenseStatus::Restricted => (
                    "restricted",
                    false,
                    Some("授权已超出宽限期，当前仅可查看与导出已有数据。".to_owned()),
                ),
            };
            LicenseView {
                status: status_name.to_owned(),
                activated: true,
                can_archive,
                username: Some(payload.un.clone()),
                expires_at: payload.aexp,
                usable_until: Some(payload.usable_until()),
                remaining_days: payload.account_remaining_days(now),
                max_seats: payload.ms,
                features: payload.feat.clone(),
                installation_id,
                platform,
                server: server.to_owned(),
                message,
            }
        }
        None => LicenseView {
            status: if runtime.license.is_some() {
                "invalid"
            } else {
                "notActivated"
            }
            .to_owned(),
            activated: false,
            can_archive: false,
            username: runtime.license.as_ref().map(|item| item.username.clone()),
            expires_at: None,
            usable_until: None,
            remaining_days: None,
            max_seats: 0,
            features: Vec::new(),
            installation_id,
            platform,
            server: server.to_owned(),
            message: runtime.last_error.clone(),
        },
    }
}

// ------------------------------------------------------------------ 守卫

/// 命令守卫：读取当前访问级别。判定完全基于本地已验签的凭证，不发起网络请求，
/// 因此不会因为服务端不可用而拖慢或阻塞本地操作。
fn access_level(state: &LicenseState) -> Result<AccessLevel, String> {
    let runtime = state
        .inner
        .lock()
        .map_err(|_| "授权状态锁不可用".to_owned())?;

    if runtime.identity.is_none() {
        return Err("设备标识尚未初始化".to_owned());
    }
    if let Some(message) = runtime.last_error.as_ref() {
        if runtime.payload.is_none() {
            return Err(message.clone());
        }
    }
    match runtime.payload.as_ref() {
        Some(payload) => Ok(match status_for(payload, now_seconds()) {
            LicenseStatus::Restricted => AccessLevel::ReadOnly,
            _ => AccessLevel::Full,
        }),
        None => Err("请在设置中激活本设备后开始备份；已有备份仍可查看和导出".to_owned()),
    }
}

/// 供需要写入能力的命令（新建归档、同步、相册写操作）调用。
///
/// 未激活或已超出宽限期都会被拒绝。新增调用点只需插入一行，无需修改函数签名。
pub fn require_archive_access() -> Result<(), String> {
    let level = access_level(LicenseState::global())?;
    if level.allows_archive() {
        Ok(())
    } else {
        Err("授权已超出宽限期，当前仅可查看与导出已有数据".to_owned())
    }
}

/// 本地浏览、搜索和导出不依赖授权状态，包括过期、撤销和未激活。
pub fn require_read_access() -> Result<(), String> {
    Ok(())
}

// -------------------------------------------------------------- 服务端通信

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    user: Option<RemoteUser>,
    #[serde(default)]
    seats: Option<Vec<RemoteSeat>>,
    #[serde(default)]
    server_time: Option<i64>,
    #[serde(default)]
    retry_after: Option<i64>,
    #[serde(default)]
    added_seats: Option<i64>,
    #[serde(default)]
    extended_days: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RemoteUser {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub max_seats: i64,
    #[serde(default)]
    pub features: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RemoteSeat {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub first_seen: i64,
    #[serde(default)]
    pub last_seen: i64,
    #[serde(default)]
    pub current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateOutcome {
    /// 业务是否成功。
    ///
    /// 口令错误、席位已满属于**正常业务结果**，用 `Ok(success=false)` 返回，
    /// 界面才能拿到「已占用的设备列表」并引导用户解绑；只有网络异常等意外才走 Err。
    pub success: bool,
    pub message: String,
    pub code: Option<String>,
    pub view: LicenseView,
    pub user: Option<RemoteUser>,
    pub seats: Vec<RemoteSeat>,
}

/// 把服务端错误码翻译成面向用户的中文提示。
///
/// 服务端刻意不区分「用户不存在」与「密码错误」，这里也保持一致。
fn describe_error(code: Option<&str>, message: Option<&str>, retry_after: Option<i64>) -> String {
    match code.unwrap_or("") {
        "BAD_CREDENTIALS" => "账号或密码不正确".to_owned(),
        "ACCOUNT_DISABLED" => "账号已被停用，请联系客服".to_owned(),
        "ACCOUNT_EXPIRED" => "授权已到期，请续费后重试".to_owned(),
        "SEAT_LIMIT" => "设备席位已满，请在已激活的设备上解绑后重试".to_owned(),
        "SEAT_REVOKED" => "本设备的授权已被解绑，请重新激活".to_owned(),
        "TOKEN_INVALID" => "授权凭证无效，请重新激活".to_owned(),
        "RATE_LIMITED" => match retry_after {
            Some(seconds) if seconds > 0 => format!("操作过于频繁，请在 {seconds} 秒后重试"),
            _ => "操作过于频繁，请稍后重试".to_owned(),
        },
        "VERSION_BLOCKED" => "当前客户端版本已被要求升级".to_owned(),
        "BAD_REQUEST" => message.unwrap_or("请求参数不正确").to_owned(),
        _ => message
            .unwrap_or("授权服务暂时不可用，请稍后重试")
            .to_owned(),
    }
}

async fn post(
    client: &reqwest::Client,
    path: &str,
    body: serde_json::Value,
) -> Result<ApiResponse, String> {
    let url = format!("{}{}", license_server().trim_end_matches('/'), path);
    let response = client
        .post(&url)
        .header("x-qza-version", env!("CARGO_PKG_VERSION"))
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "连接授权服务器超时，请检查网络".to_owned()
            } else if error.is_connect() {
                "无法连接授权服务器，请检查网络或稍后重试".to_owned()
            } else {
                format!("授权请求失败：{error}")
            }
        })?;

    response
        .json::<ApiResponse>()
        .await
        .map_err(|error| format!("授权服务器返回了无法解析的内容：{error}"))
}

/// 保存服务端下发的新凭证，并推进防重放/防回拨计数。
fn persist_license(
    app: &tauri::AppHandle,
    state: &LicenseState,
    token: &str,
    username: &str,
    server_time: Option<i64>,
) -> Result<LicensePayload, String> {
    let public_key = state.public_key.ok_or("内置公钥不可用，无法验证授权凭证")?;

    let mut runtime = state
        .inner
        .lock()
        .map_err(|_| "授权状态锁不可用".to_owned())?;
    let identity = runtime.identity.clone().ok_or("设备标识尚未初始化")?;

    let now = now_seconds();
    let payload = verify_license(token, &public_key, &identity.installation_id, now)
        .map_err(|error| error.message().to_owned())?;

    // 服务端时间用作回拨判定的权威参考。
    let reference_time = server_time.unwrap_or(now).max(now);

    let previous = runtime.license.clone().unwrap_or(StoredLicense {
        token: String::new(),
        max_seen_time: 0,
        max_seen_serial: 0,
        last_heartbeat: 0,
        username: String::new(),
    });

    let stored = StoredLicense {
        token: token.to_owned(),
        max_seen_time: previous.max_seen_time.max(reference_time),
        max_seen_serial: previous.max_seen_serial.max(payload.sn),
        last_heartbeat: reference_time,
        username: username.to_owned(),
    };

    if let Ok(text) = serde_json::to_string(&stored) {
        write_secret(app, CREDENTIAL_LICENSE, &text)?;
    }

    runtime.license = Some(stored);
    runtime.payload = Some(payload.clone());
    runtime.last_error = None;

    Ok(payload)
}

// ------------------------------------------------------------------ 命令

#[tauri::command]
pub fn get_license_status(app: tauri::AppHandle) -> LicenseView {
    let state = LicenseState::global();
    // setup 阶段已初始化过；此处兜底，避免异常路径下守卫拿到空状态。
    let needs_init = state
        .inner
        .lock()
        .map(|runtime| runtime.identity.is_none())
        .unwrap_or(false);
    if needs_init {
        initialize(&app);
    }

    let server = license_server().to_owned();
    state
        .inner
        .lock()
        .map(|runtime| view_from(&runtime, &server))
        .unwrap_or_else(|_| LicenseView {
            status: "invalid".to_owned(),
            activated: false,
            can_archive: false,
            username: None,
            expires_at: None,
            usable_until: None,
            remaining_days: None,
            max_seats: 0,
            features: Vec::new(),
            installation_id: None,
            platform: current_platform().to_owned(),
            server,
            message: Some("授权状态不可读".to_owned()),
        })
}

#[tauri::command]
pub async fn activate_license(
    app: tauri::AppHandle,
    username: String,
    password: String,
    device_label: Option<String>,
) -> Result<ActivateOutcome, String> {
    let state = LicenseState::global();
    let (installation_id, hw_hint, platform) = {
        let runtime = state
            .inner
            .lock()
            .map_err(|_| "授权状态锁不可用".to_owned())?;
        let identity = runtime.identity.clone().ok_or("设备标识尚未初始化")?;
        (
            identity.installation_id,
            identity.hw_hint,
            identity.platform,
        )
    };

    let body = serde_json::json!({
        "username": username.trim(),
        "password": password,
        "installation_id": installation_id,
        "hw_hint": hw_hint,
        "platform": platform,
        "device_label": device_label.unwrap_or_else(default_device_label),
        "app_version": env!("CARGO_PKG_VERSION"),
    });

    let response = post(&state.client, "/api/v1/activate", body).await?;

    if !response.ok {
        let message = describe_error(
            response.code.as_deref(),
            response.message.as_deref(),
            response.retry_after,
        );
        let seats = response.seats.clone().unwrap_or_default();
        {
            let mut runtime = state
                .inner
                .lock()
                .map_err(|_| "授权状态锁不可用".to_owned())?;
            runtime.last_error = Some(message.clone());
        }
        let server = license_server().to_owned();
        let view = state
            .inner
            .lock()
            .map(|runtime| view_from(&runtime, &server))
            .map_err(|_| "授权状态锁不可用".to_owned())?;

        return Ok(ActivateOutcome {
            success: false,
            message,
            code: response.code,
            view,
            user: None,
            seats,
        });
    }

    let token = response.license.as_deref().ok_or("授权服务器未返回凭证")?;
    let display_name = response
        .user
        .as_ref()
        .map(|user| user.username.clone())
        .unwrap_or_default();
    persist_license(&app, &state, token, &display_name, response.server_time)?;

    let server = license_server().to_owned();
    let view = state
        .inner
        .lock()
        .map(|runtime| view_from(&runtime, &server))
        .map_err(|_| "授权状态锁不可用".to_owned())?;

    Ok(ActivateOutcome {
        success: true,
        message: "激活成功".to_owned(),
        code: None,
        view,
        user: response.user,
        seats: response.seats.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn refresh_license(app: tauri::AppHandle) -> Result<LicenseView, String> {
    let state = LicenseState::global();
    let (installation_id, token) = {
        let runtime = state
            .inner
            .lock()
            .map_err(|_| "授权状态锁不可用".to_owned())?;
        let identity = runtime.identity.clone().ok_or("设备标识尚未初始化")?;
        let license = runtime.license.clone().ok_or("软件尚未激活")?;
        (identity.installation_id, license.token)
    };

    let body = serde_json::json!({
        "installation_id": installation_id,
        "license": token,
        "app_version": env!("CARGO_PKG_VERSION"),
    });

    let response = post(&state.client, "/api/v1/heartbeat", body).await?;
    let server = license_server().to_owned();

    if !response.ok {
        let message = describe_error(
            response.code.as_deref(),
            response.message.as_deref(),
            response.retry_after,
        );
        let revoked = matches!(
            response.code.as_deref(),
            Some("SEAT_REVOKED") | Some("TOKEN_INVALID") | Some("ACCOUNT_DISABLED")
        );

        let mut runtime = state
            .inner
            .lock()
            .map_err(|_| "授权状态锁不可用".to_owned())?;
        runtime.last_error = Some(message.clone());
        if revoked {
            // 凭证已被服务端否定，清掉本地副本，避免界面继续显示为已激活。
            let _ = delete_secret(&app, CREDENTIAL_LICENSE);
            runtime.license = None;
            runtime.payload = None;
        }
        drop(runtime);

        let view = state
            .inner
            .lock()
            .map(|runtime| view_from(&runtime, &server))
            .map_err(|_| "授权状态锁不可用".to_owned())?;

        if revoked {
            return Err(message);
        }
        // 网络类失败不视为致命：本地宽限期仍然成立。
        return Ok(view);
    }

    if let Some(token) = response.license.as_deref() {
        let display_name = state
            .inner
            .lock()
            .ok()
            .and_then(|runtime| runtime.license.as_ref().map(|item| item.username.clone()))
            .unwrap_or_default();
        persist_license(&app, &state, token, &display_name, response.server_time)?;
    }

    state
        .inner
        .lock()
        .map(|runtime| view_from(&runtime, &server))
        .map_err(|_| "授权状态锁不可用".to_owned())
}

#[tauri::command]
pub async fn list_license_seats() -> Result<Vec<RemoteSeat>, String> {
    let state = LicenseState::global();
    let token = {
        let runtime = state
            .inner
            .lock()
            .map_err(|_| "授权状态锁不可用".to_owned())?;
        runtime
            .license
            .as_ref()
            .map(|license| license.token.clone())
            .ok_or("软件尚未激活")?
    };

    let response = post(
        &state.client,
        "/api/v1/seats",
        serde_json::json!({ "license": token }),
    )
    .await?;
    if !response.ok {
        return Err(describe_error(
            response.code.as_deref(),
            response.message.as_deref(),
            response.retry_after,
        ));
    }
    Ok(response.seats.unwrap_or_default())
}

#[tauri::command]
pub async fn deactivate_license_seat(
    seat_id: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<LicenseView, String> {
    let state = LicenseState::global();

    // 双通道：
    // - 提供账号口令时走口令通道。在「席位已满、本机尚未激活」的新设备上，这是唯一可用的通道。
    // - 否则用本机凭证解绑其它设备，已激活用户无需再次输入密码。
    let body = match (username, password) {
        (Some(account), Some(secret)) if !account.trim().is_empty() && !secret.is_empty() => {
            serde_json::json!({
                "username": account.trim(),
                "password": secret,
                "seat_id": seat_id,
            })
        }
        _ => {
            let token = {
                let runtime = state
                    .inner
                    .lock()
                    .map_err(|_| "授权状态锁不可用".to_owned())?;
                runtime
                    .license
                    .as_ref()
                    .map(|license| license.token.clone())
                    .ok_or("当前设备尚未激活，请输入账号密码后再解绑")?
            };
            serde_json::json!({ "license": token, "target_seat_id": seat_id })
        }
    };

    let response = post(&state.client, "/api/v1/deactivate", body).await?;
    let server = license_server().to_owned();
    if !response.ok {
        return Err(describe_error(
            response.code.as_deref(),
            response.message.as_deref(),
            response.retry_after,
        ));
    }

    state
        .inner
        .lock()
        .map(|runtime| view_from(&runtime, &server))
        .map_err(|_| "授权状态锁不可用".to_owned())
}

#[tauri::command]
pub async fn redeem_license_code(
    username: String,
    password: String,
    code: String,
) -> Result<String, String> {
    let state = LicenseState::global();
    let body = serde_json::json!({
        "username": username.trim(),
        "password": password,
        "code": code.trim(),
    });

    let response = post(&state.client, "/api/v1/redeem", body).await?;
    if !response.ok {
        return Err(describe_error(
            response.code.as_deref(),
            response.message.as_deref(),
            response.retry_after,
        ));
    }

    let seats = response.added_seats.unwrap_or(0);
    let days = response.extended_days.unwrap_or(0);
    let mut parts = Vec::new();
    if seats > 0 {
        parts.push(format!("增加 {seats} 个设备席位"));
    }
    if days > 0 {
        parts.push(format!("延长 {days} 天"));
    }
    Ok(if parts.is_empty() {
        "兑换成功".to_owned()
    } else {
        format!("兑换成功：{}", parts.join("、"))
    })
}

/// 退出授权：清除本地凭证与设备标识，回到未激活状态。
#[tauri::command]
pub fn sign_out_license(app: tauri::AppHandle) -> Result<(), String> {
    let state = LicenseState::global();
    delete_secret(&app, CREDENTIAL_LICENSE)?;
    delete_secret(&app, CREDENTIAL_DEVICE)?;
    if let Ok(mut runtime) = state.inner.lock() {
        *runtime = Runtime::default();
    }
    Ok(())
}

/// 由 archive 模块的「删除所有数据」调用，避免删库后仍处于已激活状态。
pub fn purge_local_license(app: &tauri::AppHandle) {
    let _ = delete_secret(app, CREDENTIAL_LICENSE);
    let _ = delete_secret(app, CREDENTIAL_DEVICE);
}

/// 距离上次成功心跳是否已超过间隔。没有凭证时返回 false——未激活无需心跳。
fn heartbeat_due() -> bool {
    LicenseState::global()
        .inner
        .lock()
        .map(|runtime| match runtime.license.as_ref() {
            Some(license) => now_seconds() - license.last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS,
            None => false,
        })
        .unwrap_or(false)
}

/// 启动后台心跳。
///
/// 每小时检查一次，只有确实到期才发起请求，因此长时间运行也不会产生无谓流量。
/// 返回值刻意忽略：心跳失败不产生任何用户可见后果——本地宽限期仍然成立，
/// 界面状态由本地验签结果决定，网络恢复后下一次检查会自动补上。
pub fn spawn_heartbeat(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            if heartbeat_due() {
                let _ = refresh_license(app.clone()).await;
            }
        }
    });
}

fn default_device_label() -> String {
    let platform = match current_platform() {
        "windows" => "Windows 设备",
        "macos" => "macOS 设备",
        "linux" => "Linux 设备",
        "android" => "Android 设备",
        "ios" => "iOS 设备",
        _ => "未知设备",
    };
    platform.to_owned()
}

/// 客户端内置的 Ed25519 公钥，由 `npm run gen-keys` 生成。
/// 公钥公开无风险；私钥只存在于服务端。
pub const LICENSE_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2dESnOkaJgAVrQj6gQA6BdNdTPe2Qs5RBTbt2vhJwHc=\n-----END PUBLIC KEY-----\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_read_access_does_not_require_a_license() {
        // 没有设备身份、没有有效凭证时也必须允许访问本地备份。
        assert!(require_read_access().is_ok());
        assert!(access_level(&LicenseState::new()).is_err());
    }

    #[test]
    fn expired_and_revoked_states_remain_readable_but_cannot_archive() {
        for error in ["授权已过期", "设备已解绑", "账号已停用"] {
            let state = LicenseState::new();
            let mut runtime = state.inner.lock().unwrap();
            runtime.identity = Some(DeviceIdentity {
                installation_id: generate_uuid_v4(),
                hw_hint: String::new(),
                platform: current_platform().to_owned(),
            });
            runtime.last_error = Some(error.to_owned());
            drop(runtime);
            assert!(access_level(&state).is_err());
            assert!(require_read_access().is_ok());
        }
    }

    #[test]
    fn generates_valid_uuid_v4() {
        let value = generate_uuid_v4();
        assert_eq!(value.len(), 36, "UUID 长度应为 36: {value}");
        let parts: Vec<&str> = value.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        assert!(value.starts_with(&parts[0]));
        assert!(parts[2].starts_with('4'), "版本位应为 4: {value}");
        assert!(
            matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'),
            "变体位应正确: {value}"
        );
        assert!(value.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-'));
    }

    #[test]
    fn generated_uuids_do_not_repeat() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..512 {
            assert!(
                seen.insert(generate_uuid_v4()),
                "出现了重复的 installation_id"
            );
        }
    }

    #[test]
    fn built_in_public_key_parses() {
        // 内置公钥若写错，整个授权体系会在运行时静默失效，必须在此拦截。
        let key =
            license_core::public_key_from_pem(LICENSE_PUBLIC_KEY_PEM).expect("内置公钥应当可解析");
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn error_messages_are_actionable() {
        assert!(describe_error(Some("SEAT_LIMIT"), None, None).contains("席位"));
        assert!(describe_error(Some("BAD_CREDENTIALS"), None, None).contains("密码"));
        assert!(describe_error(Some("RATE_LIMITED"), None, Some(42)).contains("42"));
        // 未知错误码回落到服务端 message，再回落到通用提示。
        assert_eq!(describe_error(Some("WAT"), Some("自定义"), None), "自定义");
        assert!(!describe_error(None, None, None).is_empty());
    }

    #[test]
    fn platform_detection_matches_target() {
        let platform = current_platform();
        assert!(
            ["windows", "macos", "linux", "android", "ios", "unknown"].contains(&platform),
            "平台取值必须在协议允许集合内: {platform}"
        );
        if cfg!(target_os = "windows") {
            assert_eq!(platform, "windows");
        }
    }
}
