//! 授权集成层：设备身份、凭据存储、与服务端通信、命令守卫。
//!
//! 分工原则：
//! - 判定逻辑（验签、时效、防重放）全部在 `license-core`，那里可独立单元测试；
//! - 本模块只做编排与平台适配（凭据库、注册表、文件系统、HTTP）。
//!
//! **本层的校验只服务于体验**（提前提示未激活、支持离线运行），不是安全边界。
//! 真正的边界在服务端：客户端 GPLv3 开源，任何人都能编译出跳过本模块的版本，
//! 但无法伪造服务端签发的凭证，也无法使用需要服务端配合的云能力。
//!
//! **已知限制（Android，故意保留而非遗漏）**：Android 平台没有可用的 keyring 后端
//! （见 Cargo.toml 的平台分支），因此移动端凭据以**明文** JSON 落在应用私有目录
//! `app_data_dir()/license/` 下，只靠「目录私有 + 0600/0700 权限」保护，没有加密。
//! 这偏离了 AGENTS.md「凭据只进操作系统凭据库」的原则，取舍与原因写在 `write_secret`。
//! 桌面三平台（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）不受影响。

#[cfg(target_os = "android")]
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use license_core::{
    detect_clock_rollback, is_stale_serial, status_for, verify_license, LicenseError,
    LicensePayload, LicenseStatus,
};

/// 授权服务器地址。
///
/// 值来自构建期生成的部署常量：打包机上的 `qza.config.local.json` 放真实地址，
/// 公开仓库里的 `qza.config.json` 放占位地址。取值规则见 `build.rs`。
/// 本地调试用 `scripts/build-local-windows.ps1` 注入
/// `QZA_LICENSE_SERVER=http://127.0.0.1:8787` 覆盖，不必改动任何文件。
pub fn license_server() -> &'static str {
    crate::qza_config::QZA_LICENSE_SERVER
}

/// 凭据库服务名，与 qlogin.rs 的 QQ 会话共用同一命名空间，但使用不同的 account。
const CREDENTIAL_SERVICE: &str = "top.ehre.qzonearchive";
const CREDENTIAL_DEVICE: &str = "app-license-device";
const CREDENTIAL_LICENSE: &str = "app-license-token";

/// 心跳间隔：24 小时。正常使用频率远低于此。
const HEARTBEAT_INTERVAL_SECONDS: i64 = 24 * 3600;
/// 网络请求超时。
const REQUEST_TIMEOUT_SECONDS: u64 = 20;

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
///
/// 覆盖范围要说清楚：桌面三平台能取到稳定标识（Windows `MachineGuid`、Linux
/// `machine-id`、macOS `IOPlatformUUID`）；**Android 与 iOS 恒为空串**，
/// 见 `platform_hint` 的非桌面分支。所以「换系统/换主板后凭 hw_hint 找回席位」
/// 只对桌面端成立，移动端没有任何可比对线索。
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
    // 推论：移动端的 hw_hint 恒为空串，而协议规定空值不参与匹配，因此
    // 「换设备后由服务端比对 hw_hint 找回席位」在移动端**不成立** —— 这是平台限制，
    // 不是待办事项，不要在文档或界面里承诺它。
    None
}

// ------------------------------------------------------------------ 凭据

/// Android 的 keyring 后端不存在（见 Cargo.toml 的平台分支），
/// 因此移动端把凭据放在应用私有目录：其他应用不可读，卸载即清除。
///
/// **这是已知限制，不是安全设计**：文件内容是明文（原因见 `write_secret` 的说明）。
/// 这里额外做三件能真正降低风险的事，而不是假装加密：
/// 1. 拒绝空账号与任何含路径分隔符/`..` 的账号名，避免将来 account 变成变量后越出目录；
/// 2. 拒绝把许可证目录写成符号链接或普通文件，防止凭据被重定向到共享位置；
/// 3. 目录以 0700 创建（`create_dir_all` 的默认模式是 0777 & umask，过于宽松）。
#[cfg(target_os = "android")]
fn secret_path(app: &tauri::AppHandle, account: &str) -> Result<PathBuf, String> {
    if account.is_empty()
        || account.contains('/')
        || account.contains('\\')
        || account.contains("..")
    {
        return Err("许可证账号名不合法".to_owned());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?
        .join("license");

    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("许可证目录是符号链接，已拒绝读写".to_owned())
        }
        Ok(metadata) if !metadata.is_dir() => return Err("许可证路径已被非目录文件占用".to_owned()),
        _ => {}
    }

    if !dir.exists() {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(&dir)
            .map_err(|error| format!("无法创建许可证目录：{error}"))?;
    }
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
        // 已知限制（有意保留，不是遗漏）：Android 上 keyring 没有后端可用
        // （见 Cargo.toml 的平台分支），所以移动端凭据落在 app_data_dir()/license/ 下的
        // 明文 JSON —— 目录位于 /data/data/<包名>/files 这类应用私有区，其他应用或
        // 未 root 的进程读不到，但 root、adb 备份与设备取证可以直接取走。
        //
        // 这里**没有**做加密，也不假装做了：把 AES 密钥和密文放在同一个应用私有目录，
        // 只能骗过肉眼，挡不住任何能读到该目录的攻击者。真正的修法是引入
        // Android Keystore（系统持有的密钥，应用只拿到句柄），需要新增 Android 绑定
        // 依赖（如 aes-gcm + keystore/JNI 插件），属于独立任务，未纳入本次改动。
        // 因此退而求其次：文件 0600 创建并在写入后复核权限，目录 0700（见 `secret_path`）。
        use std::io::Write as _;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let path = secret_path(app, account)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| format!("保存许可证失败：{error}"))?;
        file.write_all(value.as_bytes())
            .map_err(|error| format!("保存许可证失败：{error}"))?;
        let _ = file.sync_all();
        // `OpenOptions::mode` 只对新建文件生效，覆盖旧版本可能留下的宽松权限。
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        return Ok(());
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
///
/// 刻意**不派生 `Debug`**，改用下方手写实现：`token` 是签名凭证，等同持有者的授权，
/// 一旦有人顺手 `dbg!(license)` 或 `{:?}` 就会把完整凭据打进日志文件。
#[derive(Clone, Serialize, Deserialize)]
struct StoredLicense {
    /// 服务端签发的凭证。调试输出里恒为 `<redacted>`。
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

impl std::fmt::Debug for StoredLicense {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredLicense")
            .field("token", &"<redacted>")
            .field("max_seen_time", &self.max_seen_time)
            .field("max_seen_serial", &self.max_seen_serial)
            .field("last_heartbeat", &self.last_heartbeat)
            .field("username", &self.username)
            .finish()
    }
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

/// 凭据读取的三态结果。
///
/// `read_secret` 的 `Err` 与 `Ok(None)` 含义完全不同：前者是「暂时读不到」
/// （Windows 凭据服务被停用、Linux 上没有 Secret Service、macOS keychain 拒绝访问），
/// 后者才是「确实没有记录」。原先用 `.ok().flatten()` 把两者一起折叠成 `None`，
/// 于是凭据库一旦不可用，每次启动都会生成全新的 installation_id 并覆盖旧凭据。
enum Secret {
    Found(String),
    Missing,
    /// 凭据库暂时不可用。这个分支**绝不能**被当作「没有记录」。
    Unavailable(String),
}

fn load_secret(app: &tauri::AppHandle, account: &str) -> Secret {
    match read_secret(app, account) {
        Ok(Some(text)) => Secret::Found(text),
        Ok(None) => Secret::Missing,
        Err(error) => Secret::Unavailable(error),
    }
}

/// 启动时从凭据库读到的全部状态，附带两个「读不到」的原因，供 `initialize` 区分处理。
struct LoadedRuntime {
    identity: Option<DeviceIdentity>,
    license: Option<StoredLicense>,
    /// 设备身份读不到的原因（凭据库暂时不可用）。非空时**绝不**生成新身份。
    device_unavailable: Option<String>,
    /// 授权凭证读不到的原因，仅用于界面提示。
    license_unavailable: Option<String>,
}

fn load_runtime(app: &tauri::AppHandle) -> LoadedRuntime {
    // 记录存在但 JSON 损坏时仍按「没有记录」处理并重建：损坏的安装标识无法参与验签，
    // 也无从恢复，重建是唯一能继续使用的路径（代价是一个席位，但不会反复消耗）。
    let (identity, device_unavailable) = match load_secret(app, CREDENTIAL_DEVICE) {
        Secret::Found(text) => (serde_json::from_str::<DeviceIdentity>(&text).ok(), None),
        Secret::Missing => (None, None),
        Secret::Unavailable(error) => (None, Some(error)),
    };

    let (license, license_unavailable) = match load_secret(app, CREDENTIAL_LICENSE) {
        Secret::Found(text) => (serde_json::from_str::<StoredLicense>(&text).ok(), None),
        Secret::Missing => (None, None),
        Secret::Unavailable(error) => (None, Some(error)),
    };

    LoadedRuntime {
        identity,
        license,
        device_unavailable,
        license_unavailable,
    }
}

/// 初始化：读取或生成设备身份，并校验本地凭证。
///
/// 时间回拨在此处判定，结果落进 `last_error` 供界面展示。
/// 在 Tauri setup 阶段调用一次，因此命令守卫无需再关心初始化时机。
///
/// 身份与水位必须在函数结束前回写凭据库，否则会出现两个可复现的绕过/失效：
/// - `max_seen_time` 只写内存副本时，磁盘水位永远停在旧值——先让时钟跑快抬高内存水位、
///   重启、再回拨，检测就再也不触发；
/// - `hw_hint` 只写内存副本时，「换主板/换系统后由服务端比对找回席位」这件事永不成立。
/// 两处写失败都只记日志：本次启动的内存状态依然有效，下次启动会重试。
pub fn initialize(app: &tauri::AppHandle) {
    let state = LicenseState::global();
    let loaded = load_runtime(app);
    let mut runtime = Runtime {
        identity: loaded.identity,
        license: loaded.license,
        payload: None,
        last_error: None,
    };

    let current_hint = hardware_hint();
    let mut last_error: Option<String> = None;
    // 身份是否变化到需要回写凭据库（新建，或 hw_hint 漂移）。
    let mut identity_dirty = false;

    // hw_hint 每次启动重新采集：桌面端它是「installation_id 丢失后找回席位」的唯一线索，
    // 必须反映当前硬件，而不是首次安装时的快照；采集到的新值会随身份一起回写凭据库（原先只改内存，
    // 服务端永远拿不到这个线索）。移动端 `platform_hint` 恒为 None，这里只是维持空串。
    let mut identity = match runtime.identity.take() {
        Some(mut existing) => {
            if existing.hw_hint != current_hint {
                existing.hw_hint = current_hint;
                identity_dirty = true;
            }
            Some(existing)
        }
        None => match loaded.device_unavailable.as_deref() {
            // 凭据库暂时不可用（而**不是**没有记录）。这里若按「没有记录」处理，
            // 就会生成新的 installation_id 并覆盖旧凭据：每次启动烧掉一个席位，
            // 数轮之后账号撞上 SEAT_LIMIT，旧身份再无找回入口。
            // 因此保持身份为空并给出可重试的原因，让激活与心跳明确失败。
            Some(reason) => {
                last_error = Some(format!("设备身份暂不可用：{reason}"));
                None
            }
            // 确认是 NoEntry：这才是真正需要新身份的路径。
            None => {
                let fresh = DeviceIdentity {
                    hw_hint: current_hint,
                    ..DeviceIdentity::create()
                };
                identity_dirty = true;
                Some(fresh)
            }
        },
    };

    let now = now_seconds();

    if let Some(license) = runtime.license.clone() {
        let max_seen_time = license.max_seen_time.max(now);
        if detect_clock_rollback(now, license.max_seen_time) {
            last_error = Some(LicenseError::ClockRollback.message().to_owned());
        }
        // 原先此处有个 `is_stale_serial(0, ...)` 的占位分支，恒为 false。
        // 防重放已改为在写入路径上真正生效，见 `persist_license`。

        // 身份不可用时无法比对 iid，跳过验签（payload 保持为空，由守卫拒绝）；
        // 水位仍要维护，它与身份无关，落盘后即可挡住「重启再回拨」。
        if let Some(identity) = identity.as_ref() {
            match state.public_key {
                Some(key) => {
                    match verify_license(&license.token, &key, &identity.installation_id, now) {
                        Ok(payload) => runtime.payload = Some(payload),
                        Err(error) => last_error = Some(error.message().to_owned()),
                    }
                }
                None => last_error = Some("内置公钥不可用".to_owned()),
            }
        }

        let mut updated = license;
        if max_seen_time != updated.max_seen_time {
            updated.max_seen_time = max_seen_time;
            // 只在确实前进时落盘，避免每次启动都无谓写一次凭据库。
            match serde_json::to_string(&updated) {
                Ok(text) => {
                    if let Err(error) = write_secret(app, CREDENTIAL_LICENSE, &text) {
                        eprintln!("[license] 水位落盘失败（内存水位仍有效）：{error}");
                    }
                }
                Err(error) => eprintln!("[license] 授权状态序列化失败：{error}"),
            }
        }
        runtime.license = Some(updated);
    } else if let Some(reason) = loaded.license_unavailable.as_deref() {
        // 凭据确实存在但读不到：不能按「未激活」呈现，否则用户会以为要重新激活，
        // 而重新激活恰好会再占一个席位。
        if last_error.is_none() {
            last_error = Some(format!("授权凭证暂时无法读取：{reason}"));
        }
    }

    if let Some(identity) = identity.take() {
        if identity_dirty {
            match serde_json::to_string(&identity) {
                Ok(text) => {
                    if let Err(error) = write_secret(app, CREDENTIAL_DEVICE, &text) {
                        eprintln!("[license] 设备身份写回凭据库失败：{error}");
                        if last_error.is_none() {
                            last_error = Some(format!("设备身份无法写入系统凭据库：{error}"));
                        }
                    }
                }
                Err(error) => eprintln!("[license] 设备身份序列化失败：{error}"),
            }
        }
        runtime.identity = Some(identity);
    }

    // 从公开源码直接构建时拿到的是占位配置，激活请求永远失败。占位地址下的失败会
    // 被网络层折叠成一句笼统的「网络错误」，用户无从判断是配置问题还是服务问题，
    // 所以在这里把它变成一句明确提示。已有更具体的错误时不覆盖。
    if crate::qza_config::CONFIG_IS_PLACEHOLDER && last_error.is_none() {
        last_error = Some(format!(
            "本构建未配置授权服务器，激活请求会发往占位地址 {}",
            license_server()
        ));
    }

    runtime.last_error = last_error;

    match state.inner.lock() {
        Ok(mut guard) => *guard = runtime,
        // 中毒只说明持锁线程 panic 过。`Runtime` 里没有可能被写坏的内部不变量，
        // 因此记一条日志后照样写回，好过让整个授权层静默失效。
        Err(poisoned) => {
            eprintln!("[license] 授权状态锁已中毒，初始化结果仍会写回");
            *poisoned.into_inner() = runtime;
        }
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
        // 身份缺失有两种来源：从未初始化，以及凭据库暂时不可用（见 `initialize`）。
        // 后者是可重试的状态，必须把那里的具体原因透出来，否则用户会以为需要重新激活，
        // 而重新激活恰好会再占一个席位。
        return Err(runtime
            .last_error
            .clone()
            .unwrap_or_else(|| "设备标识尚未初始化".to_owned()));
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
///
/// 注意：本函数**恒为 `Ok(())`**，不提供任何保护。函数名保留是因为 `archive.rs`
/// 已有 18 处调用，改名会扩散到本次改动范围之外；请把它理解为「这里是本地数据路径」
/// 的调用点标记，而不是守卫。凡是写本地数据、发起归档或访问腾讯服务端的地方，
/// 必须改用 `require_archive_access()`。
///
/// AGENTS.md 的硬约束：授权失效可以限制「发起新的归档」，但绝不能让用户
/// 失去磁盘上已有的归档，所以这个位置不该出现真正的判定。
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

    // 防重放：服务端下发的序列号只能前进。原实现里 `is_stale_serial` 在客户端零调用、
    // `max_seen_serial` 只写不读，PROTOCOL 声称的「还原旧 token 会被识别」从未生效。
    //
    // 只拒绝序列号**回退**的情况：服务端对同一席位正常重新签发（心跳、续期、换机重绑）
    // 会让 sn 递增或至少持平，因此不会被这条规则误伤；首次激活时参照值为 0，
    // 而 sn 已由 license-core 校验为非负，也不会误判。
    //
    // 逃生口：万一服务端重置了序列号（例如席位被删后重绑同一 installation_id），
    // 提示语必须给出「先退出授权再激活」——退出会清掉本地参照值，避免用户卡在死循环里。
    if is_stale_serial(payload.sn, previous.max_seen_serial) {
        return Err("本地凭证序号比服务端下发的更新，请先退出授权后再重新激活".to_owned());
    }

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
        let identity = match runtime.identity.clone() {
            Some(identity) => identity,
            // 凭据库暂时不可用时（见 `initialize`）给出具体且可重试的原因，
            // 而不是笼统的「尚未初始化」——后者会让用户以为需要重新激活，从而再占一个席位。
            None => {
                return Err(runtime
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "设备标识尚未初始化".to_owned()))
            }
        };
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
        let identity = match runtime.identity.clone() {
            Some(identity) => identity,
            // 同上：区分「凭据库暂不可用」与「尚未初始化」，前者是可重试的状态。
            None => {
                return Err(runtime
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "设备标识尚未初始化".to_owned()))
            }
        };
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

    // 心跳成功即代表服务端仍然认这个席位，因此无论是否下发新凭证都要清掉上一次的失败原因。
    // 否则旧的「连接授权服务器超时」会一直留着，在下次 payload 为空时变成用户可见的
    // 拒绝理由——把「设备已解绑」显示成网络超时，用户会去排查网络。
    if let Ok(mut runtime) = state.inner.lock() {
        runtime.last_error = None;
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

/// 客户端内置的 Ed25519 公钥，用来验证服务端签发的授权凭证。
///
/// 值来自构建期生成的部署常量。公钥公开无风险；对应的私钥只存在于服务端
/// `/opt/qza-license/secrets/license_private.pem`，由 `npm run gen-keys` 在该机器上
/// 生成后从未离开。改动这里的公钥等于让所有已签发的凭证失效。
///
/// 公开仓库里带的是占位公钥 —— 它能解析、但验不过任何真实凭证。自建授权服务时
/// 必须在 `qza.config.local.json` 里换成自己的公钥，否则本地密钥签发的凭证会
/// 全部校验失败。
pub use crate::qza_config::QZA_LICENSE_PUBLIC_KEY as LICENSE_PUBLIC_KEY_PEM;

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
    fn stored_license_debug_never_leaks_the_token() {
        // 手写 Debug 的意义就在于此：将来有人把 derive 加回来，这条会立刻失败。
        let stored = StoredLicense {
            token: "QZA1.PAYLOAD.SIGNATURE".to_owned(),
            max_seen_time: 1,
            max_seen_serial: 2,
            last_heartbeat: 3,
            username: "tester".to_owned(),
        };
        let rendered = format!("{stored:?}");
        assert!(
            !rendered.contains("PAYLOAD"),
            "调试输出不得包含 token：{rendered}"
        );
        assert!(rendered.contains("<redacted>"));
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
