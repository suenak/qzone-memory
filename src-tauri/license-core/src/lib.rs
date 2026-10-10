//! QZA 授权凭证的纯逻辑：解析、验签、时效与防重放判定。
//!
//! 本 crate 刻意**不依赖 Tauri**，因此可以脱离 GUI 环境独立单元测试。
//! 所有与操作系统交互的部分（设备指纹采集、凭据库读写、HTTP 心跳）都留在
//! Tauri 侧的 `license.rs`，那里只做编排，不做判定。
//!
//! 协议依据：PROTOCOL.md 第 2 节。

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;

/// token 头部前缀。遇到不认识的版本必须拒绝，不得降级猜测。
pub const TOKEN_PREFIX: &str = "QZA1";
/// 当前支持的 payload 版本。
pub const PAYLOAD_VERSION: i32 = 1;
/// 时间回拨容忍窗口（秒）。小于此幅度的系统时间波动视为正常校准。
pub const CLOCK_ROLLBACK_TOLERANCE_SECONDS: i64 = 3600;
/// 宽限期上限（天）：十年。`grc` 是**宽容字段**——超出只钳制，不让整张凭证失效，
/// 否则服务端一旦签发更大的宽限期，全部旧客户端会立刻拒绝合法用户。
pub const MAX_GRACE_DAYS: i64 = 3650;
/// 时间戳合理上界：9999-12-31T23:59:59Z。
///
/// `iat`/`exp` 超出此值属于畸形数据：签名只能证明字段来自服务端，证明不了服务端没有 bug，
/// 而畸形的 `exp` 会让整套失效判定失去意义。
pub const MAX_PLAUSIBLE_TIMESTAMP: i64 = 253_402_300_799;
/// 序列号上界：2^40。按每天一次心跳也够用三十亿年，超出只可能是畸形值。
pub const MAX_SERIAL: i64 = 1 << 40;

/// Ed25519 SubjectPublicKeyInfo DER 的固定前缀。
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseError {
    /// 结构不合法：段数、base64、JSON 或签名长度有问题。
    Malformed,
    /// 版本前缀或 payload 版本不受支持。
    UnsupportedVersion,
    /// 签名校验失败。这是伪造服务器或篡改凭证的统一出口。
    BadSignature,
    /// 凭证绑定的设备与当前设备不一致。
    NotForThisDevice,
    /// 超出有效期 + 宽限期。
    Expired,
    /// 系统时间早于历史最大观察时间，疑似回拨。
    ClockRollback,
}

impl LicenseError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::Malformed => "授权凭证格式不正确",
            Self::UnsupportedVersion => "授权凭证版本不受支持，请升级客户端",
            Self::BadSignature => "授权凭证签名无效",
            Self::NotForThisDevice => "该授权凭证不属于当前设备",
            Self::Expired => "授权已过期，请联网续期",
            Self::ClockRollback => "检测到系统时间异常",
        }
    }
}

impl std::fmt::Display for LicenseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for LicenseError {}

/// 服务端签发的凭证内容。字段名与 PROTOCOL.md 2.2 一一对应。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct LicensePayload {
    pub v: i32,
    pub sub: String,
    pub un: String,
    pub sid: String,
    pub iid: String,
    pub iat: i64,
    pub exp: i64,
    /// 账号授权到期日；0 为永久，旧凭证缺少此字段时为未知。
    #[serde(default)]
    pub aexp: Option<i64>,
    pub grc: i64,
    pub sn: i64,
    /// 账号允许的设备席位数。旧凭证可能没有此字段，缺省 0 表示未知，界面按未知处理。
    #[serde(default)]
    pub ms: i64,
    #[serde(default)]
    pub feat: Vec<String>,
}

impl LicensePayload {
    /// 账号剩余天数不包含设备凭证的离线宽限期。
    pub fn account_remaining_days(&self, now: i64) -> Option<i64> {
        self.aexp
            .filter(|expiry| *expiry > 0)
            .map(|expiry| expiry.saturating_sub(now).max(0).saturating_add(86_399) / 86_400)
    }

    pub fn has_feature(&self, name: &str) -> bool {
        self.feat.iter().any(|item| item == name)
    }

    /// 最后一刻可用的 Unix 时间戳：过期时间 + 离线宽限期。
    ///
    /// 心跳连续失败时客户端靠这个窗口继续运行；超过它才进入受限状态。
    ///
    /// 全程饱和运算（与本文件 `account_remaining_days` 的做法保持一致）：畸形的
    /// `exp`/`grc` 原先会让 `exp + grc.max(0) * 86_400` 在 debug 构建 panic
    /// （调用点在 Tauri `setup` 阶段，等于建窗即崩），在 release 里回绕成负数，
    /// 反把合法用户判成 `Restricted`。`grc` 钳到 `MAX_GRACE_DAYS`，不因它拒绝凭证。
    pub fn usable_until(&self) -> i64 {
        self.exp
            .saturating_add(self.grc.clamp(0, MAX_GRACE_DAYS).saturating_mul(86_400))
    }

    /// 距离彻底失效还有多少秒，已失效返回负数。
    pub fn remaining_seconds(&self, now: i64) -> i64 {
        self.usable_until() - now
    }
}

/// 从 token 中拆出「签名输入」与「签名」。
///
/// 签名输入是 `QZA1.<payload>` 整段 ASCII，因此替换 payload 会立刻破坏签名，
/// 单独替换前缀也会。
pub fn split_token(token: &str) -> Result<(String, Vec<u8>), LicenseError> {
    let mut parts = token.split('.');
    let prefix = parts.next().ok_or(LicenseError::Malformed)?;
    let payload = parts.next().ok_or(LicenseError::Malformed)?;
    let signature = parts.next().ok_or(LicenseError::Malformed)?;
    if parts.next().is_some() {
        return Err(LicenseError::Malformed);
    }
    if prefix != TOKEN_PREFIX {
        return Err(LicenseError::UnsupportedVersion);
    }
    if payload.is_empty() || signature.is_empty() {
        return Err(LicenseError::Malformed);
    }

    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| LicenseError::Malformed)?;
    if signature.len() != 64 {
        return Err(LicenseError::Malformed);
    }
    Ok((format!("{prefix}.{payload}"), signature))
}

/// 解析 payload 并校验其内部版本号。
pub fn decode_payload(signing_input: &str) -> Result<LicensePayload, LicenseError> {
    let encoded = signing_input
        .split_once('.')
        .ok_or(LicenseError::Malformed)?
        .1;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| LicenseError::Malformed)?;
    let payload: LicensePayload =
        serde_json::from_slice(&bytes).map_err(|_| LicenseError::Malformed)?;
    if payload.v != PAYLOAD_VERSION {
        return Err(LicenseError::UnsupportedVersion);
    }
    check_numeric_bounds(&payload)?;
    Ok(payload)
}

/// payload 的数值边界检查。
///
/// 放在解析阶段而不是业务判定里：越界的 `iat`/`exp`/`sn` 属于「结构不合法」，
/// 应与 base64/JSON 错误一样直接拒绝，而不是带着回绕后的数字继续参与判定。
fn check_numeric_bounds(payload: &LicensePayload) -> Result<(), LicenseError> {
    if !(0..=MAX_PLAUSIBLE_TIMESTAMP).contains(&payload.iat) {
        return Err(LicenseError::Malformed);
    }
    if !(0..=MAX_PLAUSIBLE_TIMESTAMP).contains(&payload.exp) {
        return Err(LicenseError::Malformed);
    }
    // sn 参与持久化的取 max 与防重放比较，负值或天文数字都只可能是脏数据。
    if !(0..=MAX_SERIAL).contains(&payload.sn) {
        return Err(LicenseError::Malformed);
    }
    Ok(())
}

/// Ed25519 验签。
pub fn verify_signature(
    signing_input: &str,
    signature: &[u8],
    public_key: &[u8; 32],
) -> Result<(), LicenseError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let key = VerifyingKey::from_bytes(public_key).map_err(|_| LicenseError::BadSignature)?;
    let signature = Signature::from_slice(signature).map_err(|_| LicenseError::Malformed)?;
    key.verify(signing_input.as_bytes(), &signature)
        .map_err(|_| LicenseError::BadSignature)
}

/// 从 Ed25519 SPKI PEM 中取出 32 字节裸公钥。
///
/// 客户端内置公钥，公开无风险；私钥只存在于服务端。
pub fn public_key_from_pem(pem: &str) -> Result<[u8; 32], LicenseError> {
    let body: String = pem
        .lines()
        .filter(|line| !line.trim_start().starts_with("-----"))
        .map(str::trim)
        .collect();
    let der = STANDARD
        .decode(body.as_bytes())
        .map_err(|_| LicenseError::Malformed)?;
    if der.len() != 44 || der[..12] != ED25519_SPKI_PREFIX {
        return Err(LicenseError::Malformed);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&der[12..44]);
    Ok(key)
}

/// 校验凭证是否适用于本机且未过宽限期。
pub fn check_validity(
    payload: &LicensePayload,
    installation_id: &str,
    now: i64,
) -> Result<(), LicenseError> {
    if payload.iid != installation_id {
        return Err(LicenseError::NotForThisDevice);
    }
    if now > payload.usable_until() {
        return Err(LicenseError::Expired);
    }
    Ok(())
}

/// 完整校验：拆段 -> 验签 -> 解析 -> 设备与时效检查。
///
/// 注意顺序：先验签再解析。未签名的数据一律当作不可信输入，不进入业务判断。
pub fn verify_license(
    token: &str,
    public_key: &[u8; 32],
    installation_id: &str,
    now: i64,
) -> Result<LicensePayload, LicenseError> {
    let (signing_input, signature) = split_token(token)?;
    verify_signature(&signing_input, &signature, public_key)?;
    let payload = decode_payload(&signing_input)?;
    check_validity(&payload, installation_id, now)?;
    Ok(payload)
}

/// 系统时间是否被回拨。
///
/// 用户把系统时间调回去是延长离线授权最省事的办法，因此必须记录历史最大
/// 观察时间。容忍窗口用于吸收 NTP 校准带来的小幅回退。
pub fn detect_clock_rollback(now: i64, max_seen_time: i64) -> bool {
    max_seen_time > 0 && now < max_seen_time - CLOCK_ROLLBACK_TOLERANCE_SECONDS
}

/// 收到的凭证序列号是否比已记录的更旧。
///
/// 用于识别重放：把早先备份的旧 token 还原回去，其 sn 会低于本地记录。
pub fn is_stale_serial(serial: i64, max_seen_serial: i64) -> bool {
    serial < max_seen_serial
}

/// 依据剩余宽限时间判断应处的运行状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseStatus {
    /// 正常，距失效还有缓冲。
    Active,
    /// 仍在宽限期内，可用但应尽快联网。
    Grace,
    /// 已超出宽限期，仅允许查看与导出既有本地数据。
    Restricted,
}

pub fn status_for(payload: &LicensePayload, now: i64) -> LicenseStatus {
    if now > payload.usable_until() {
        LicenseStatus::Restricted
    } else if now > payload.exp {
        LicenseStatus::Grace
    } else {
        LicenseStatus::Active
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    const INSTALLATION: &str = "3f2a0000-0000-4000-8000-000000000001";
    const NOW: i64 = 1_730_000_000;

    fn keys() -> (SigningKey, [u8; 32]) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let verifying = signing.verifying_key().to_bytes();
        (signing, verifying)
    }

    fn issue(signing: &SigningKey, mut payload: serde_json::Value) -> String {
        if payload.get("v").is_none() {
            payload["v"] = json!(PAYLOAD_VERSION);
        }
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signing_input = format!("{TOKEN_PREFIX}.{encoded}");
        let signature = signing.sign(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    fn payload_for(installation_id: &str, now: i64) -> serde_json::Value {
        json!({
            "v": 1,
            "sub": "42",
            "un": "tester",
            "sid": "7",
            "iid": installation_id,
            "iat": now,
            "exp": now + 86_400,
            "grc": 15,
            "sn": 5,
            "feat": ["archive", "export"]
        })
    }

    /// 手工拼出 Ed25519 SPKI PEM。刻意不依赖 pkcs8 feature，
    /// 这样测的就是本 crate 自己的解析器而不是某个库的编码器。
    /// 按 48 字符折行，以便覆盖多行 PEM 的处理。
    fn to_pem(key: &[u8; 32]) -> String {
        let mut der = Vec::from(ED25519_SPKI_PREFIX);
        der.extend_from_slice(key);
        let encoded = STANDARD.encode(&der);
        let mut body = String::new();
        for chunk in encoded.as_bytes().chunks(48) {
            body.push_str(std::str::from_utf8(chunk).unwrap());
            body.push('\n');
        }
        format!("-----BEGIN PUBLIC KEY-----\n{body}-----END PUBLIC KEY-----\n")
    }

    #[test]
    fn accepts_valid_token() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let payload = verify_license(&token, &verifying, INSTALLATION, NOW).expect("应当通过");
        assert_eq!(payload.sub, "42");
        assert_eq!(payload.sid, "7");
        assert_eq!(payload.sn, 5);
        assert!(payload.has_feature("archive"));
        assert!(!payload.has_feature("cloud-backup"));
    }

    #[test]
    fn rejects_tampered_payload() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let parts: Vec<&str> = token.split('.').collect();

        // 给自己加一个未购买的能力，签名必须立刻失效。
        let mut payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        payload["feat"] = json!(["archive", "export", "cloud-backup", "priority-support"]);
        let forged_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let forged = format!("QZA1.{forged_payload}.{}", parts[2]);

        assert_eq!(
            verify_license(&forged, &verifying, INSTALLATION, NOW),
            Err(LicenseError::BadSignature)
        );
    }

    #[test]
    fn rejects_tampered_expiry() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let parts: Vec<&str> = token.split('.').collect();

        let mut payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        payload["exp"] = json!(NOW + 86_400 * 3650);
        let forged_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let forged = format!("QZA1.{forged_payload}.{}", parts[2]);

        assert_eq!(
            verify_license(&forged, &verifying, INSTALLATION, NOW),
            Err(LicenseError::BadSignature)
        );
    }

    #[test]
    fn rejects_flipped_signature() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let mut bytes = token.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();

        let result = verify_license(&tampered, &verifying, INSTALLATION, NOW);
        assert!(matches!(
            result,
            Err(LicenseError::BadSignature) | Err(LicenseError::Malformed)
        ));
    }

    #[test]
    fn rejects_foreign_public_key() {
        let (signing, _) = keys();
        let other = SigningKey::from_bytes(&[9u8; 32])
            .verifying_key()
            .to_bytes();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));

        assert_eq!(
            verify_license(&token, &other, INSTALLATION, NOW),
            Err(LicenseError::BadSignature)
        );
    }

    #[test]
    fn rejects_foreign_device() {
        let (signing, verifying) = keys();
        let token = issue(
            &signing,
            payload_for("aaaa0000-0000-4000-8000-000000000009", NOW),
        );

        assert_eq!(
            verify_license(&token, &verifying, INSTALLATION, NOW),
            Err(LicenseError::NotForThisDevice)
        );
    }

    #[test]
    fn accepts_within_grace_period() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));

        // exp 已过 1 天，宽限期 15 天，仍应可用。
        let later = NOW + 86_400 + 86_400;
        let payload =
            verify_license(&token, &verifying, INSTALLATION, later).expect("宽限期内应可用");
        assert_eq!(status_for(&payload, later), LicenseStatus::Grace);
    }

    #[test]
    fn rejects_beyond_grace_period() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));

        // exp + 15 天之后。
        let too_late = NOW + 86_400 + 15 * 86_400 + 1;
        assert_eq!(
            verify_license(&token, &verifying, INSTALLATION, too_late),
            Err(LicenseError::Expired)
        );
    }

    #[test]
    fn status_transitions() {
        let (signing, _) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let (signing_input, _) = split_token(&token).unwrap();
        let payload = decode_payload(&signing_input).unwrap();

        assert_eq!(status_for(&payload, NOW), LicenseStatus::Active);
        assert_eq!(status_for(&payload, NOW + 86_400), LicenseStatus::Active);
        assert_eq!(status_for(&payload, NOW + 86_400 + 1), LicenseStatus::Grace);
        assert_eq!(
            status_for(&payload, payload.usable_until() + 1),
            LicenseStatus::Restricted
        );
        assert_eq!(payload.remaining_seconds(NOW), 86_400 + 15 * 86_400);
    }

    #[test]
    fn rejects_malformed_tokens() {
        let (_, verifying) = keys();
        for token in [
            "",
            "QZA1",
            "QZA1.only-two-parts",
            "QZA1.a.b.c.d",
            "QZA2.aaaa.bbbb",
            "QZA1..",
            "QZA1.!!!.!!!",
        ] {
            let result = verify_license(token, &verifying, INSTALLATION, NOW);
            assert!(result.is_err(), "应拒绝: {token}");
        }
    }

    #[test]
    fn rejects_wrong_version_prefix() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let downgraded = token.replacen("QZA1.", "QZA0.", 1);

        assert_eq!(
            verify_license(&downgraded, &verifying, INSTALLATION, NOW),
            Err(LicenseError::UnsupportedVersion)
        );
    }

    #[test]
    fn rejects_unsupported_payload_version() {
        let (signing, verifying) = keys();
        let mut payload = payload_for(INSTALLATION, NOW);
        payload["v"] = json!(99);
        let token = issue(&signing, payload);

        assert_eq!(
            verify_license(&token, &verifying, INSTALLATION, NOW),
            Err(LicenseError::UnsupportedVersion)
        );
    }

    #[test]
    fn detects_clock_rollback() {
        assert!(!detect_clock_rollback(NOW, 0), "首次运行不应判定回拨");
        assert!(!detect_clock_rollback(NOW - 60, NOW), "小幅回退应被容忍");
        assert!(
            !detect_clock_rollback(NOW - 3600, NOW),
            "恰好一小时应被容忍"
        );
        assert!(detect_clock_rollback(NOW - 3601, NOW), "超过容忍窗口应触发");
        assert!(
            detect_clock_rollback(NOW - 86_400 * 30, NOW),
            "回拨一个月应触发"
        );
    }

    #[test]
    fn detects_stale_serial() {
        assert!(!is_stale_serial(5, 5));
        assert!(!is_stale_serial(6, 5));
        assert!(is_stale_serial(4, 5), "旧凭证重放应被识别");
    }

    #[test]
    fn clamps_absurd_grace_period_instead_of_overflowing() {
        let (signing, _) = keys();
        // 旧写法 `exp + grc.max(0) * 86_400`：debug 构建 panic，release 回绕成负数。
        let mut value = payload_for(INSTALLATION, NOW);
        value["grc"] = json!(i64::MAX);
        let token = issue(&signing, value);
        let (signing_input, _) = split_token(&token).unwrap();
        let payload = decode_payload(&signing_input).unwrap();

        // grc 是宽容字段：钳到 MAX_GRACE_DAYS，凭证本身仍然可用。
        let expected = NOW + 86_400 + MAX_GRACE_DAYS * 86_400;
        assert_eq!(payload.usable_until(), expected);
        assert_eq!(status_for(&payload, NOW + 86_400 + 1), LicenseStatus::Grace);
    }

    #[test]
    fn negative_grace_period_never_shortens_the_usable_window() {
        let (signing, _) = keys();
        let mut value = payload_for(INSTALLATION, NOW);
        value["grc"] = json!(i64::MIN);
        let token = issue(&signing, value);
        let (signing_input, _) = split_token(&token).unwrap();
        let payload = decode_payload(&signing_input).unwrap();

        assert_eq!(payload.usable_until(), NOW + 86_400);
        assert_eq!(payload.remaining_seconds(NOW), 86_400);
    }

    #[test]
    fn rejects_out_of_range_numeric_fields() {
        let (signing, verifying) = keys();
        for (field, bad) in [
            ("iat", json!(-1)),
            ("iat", json!(MAX_PLAUSIBLE_TIMESTAMP + 1)),
            ("exp", json!(-1)),
            ("exp", json!(MAX_PLAUSIBLE_TIMESTAMP + 1)),
            ("sn", json!(-1)),
            ("sn", json!(MAX_SERIAL + 1)),
        ] {
            let mut value = payload_for(INSTALLATION, NOW);
            value[field] = bad;
            let token = issue(&signing, value);
            // 上界与下界越界都属于「结构不合法」，与 base64/JSON 错误同一出口。
            let result = verify_license(&token, &verifying, INSTALLATION, NOW);
            assert_eq!(result, Err(LicenseError::Malformed));
        }
    }

    #[test]
    fn accepts_boundary_numeric_values() {
        let (signing, verifying) = keys();
        let mut value = payload_for(INSTALLATION, NOW);
        value["sn"] = json!(MAX_SERIAL);
        value["exp"] = json!(MAX_PLAUSIBLE_TIMESTAMP);
        let token = issue(&signing, value);

        // 上界本身是合法值：只有越界才拒绝，避免边界写错导致正常凭证被拒。
        let payload = verify_license(&token, &verifying, INSTALLATION, NOW).expect("边界值应通过");
        assert_eq!(payload.sn, MAX_SERIAL);
    }

    #[test]
    fn parses_public_key_from_pem() {
        let (_, expected) = keys();
        let parsed = public_key_from_pem(&to_pem(&expected)).expect("PEM 应可解析");
        assert_eq!(parsed, expected);

        assert!(public_key_from_pem("not a pem").is_err());
        assert!(
            public_key_from_pem("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")
                .is_err(),
            "长度不足的 DER 应被拒绝"
        );

        // 前缀正确但整体长度不对，同样要拒绝。
        let mut long = Vec::from(ED25519_SPKI_PREFIX);
        long.extend_from_slice(&[1u8; 33]);
        let bad = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
            STANDARD.encode(&long)
        );
        assert!(public_key_from_pem(&bad).is_err());
    }

    #[test]
    fn pem_round_trip_validates_real_token() {
        // 完整链路：PEM -> 裸公钥 -> 验签。
        let (signing, verifying) = keys();
        let key = public_key_from_pem(&to_pem(&verifying)).unwrap();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));

        assert!(verify_license(&token, &key, INSTALLATION, NOW).is_ok());
    }

    #[test]
    fn account_expiry_is_independent_of_device_token() {
        let (signing, verifying) = keys();
        let mut value = payload_for(INSTALLATION, NOW);
        value["aexp"] = json!(NOW + 365 * 86_400);
        let token = issue(&signing, value);
        let payload = verify_license(&token, &verifying, INSTALLATION, NOW).unwrap();
        assert_eq!(payload.aexp, Some(NOW + 365 * 86_400));
        assert_eq!(payload.account_remaining_days(NOW), Some(365));
        assert_eq!(payload.usable_until(), NOW + 16 * 86_400);
        assert_eq!(
            status_for(&payload, NOW + 17 * 86_400),
            LicenseStatus::Restricted
        );
        assert_eq!(payload.account_remaining_days(NOW + 365 * 86_400), Some(0));
    }

    #[test]
    fn permanent_account_still_has_a_finite_device_token() {
        let (signing, verifying) = keys();
        let mut value = payload_for(INSTALLATION, NOW);
        value["aexp"] = json!(0);
        let token = issue(&signing, value);
        let payload = verify_license(&token, &verifying, INSTALLATION, NOW).unwrap();
        assert_eq!(payload.aexp, Some(0));
        assert_eq!(payload.account_remaining_days(NOW), None);
        assert_eq!(
            status_for(&payload, NOW + 17 * 86_400),
            LicenseStatus::Restricted
        );
    }

    #[test]
    fn old_token_does_not_invent_account_expiry() {
        let (signing, verifying) = keys();
        let token = issue(&signing, payload_for(INSTALLATION, NOW));
        let payload = verify_license(&token, &verifying, INSTALLATION, NOW).unwrap();
        assert_eq!(payload.aexp, None);
        assert_eq!(payload.account_remaining_days(NOW), None);
    }
}
