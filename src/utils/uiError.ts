/** 只改变错误呈现，不改变返回值、登录状态或重试路径。 */
export function describeError(reason: unknown, fallback = "操作失败，请重试。") {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  if (/__TAURI|undefined.*invoke|reading ['"]invoke|IPC/i.test(message)) return "当前页面无法连接本地服务。请在桌面或手机应用中打开，再试一次。";
  if (/归档.*进行|归档.*运行|archive.*running|正在归档/i.test(message)) return "请先停止备份，再进行此操作。";
  if (/登录|login|session.*expired|unauthorized|401/i.test(message)) return "请重新登录 QQ 空间后再试。";
  if (/限流|频繁|429|rate.?limit/i.test(message)) return "请求暂时过于频繁。已保存的内容不受影响，稍后可以继续。";
  if (/network|fetch|网络|连接|timeout|超时|dns/i.test(message)) return "连接失败，请检查网络后重试。";
  if (/授权|license|activation/i.test(message)) return "当前授权暂时无法完成此操作，请在设置中检查授权状态。";
  if (/database|sqlite|数据库|资料库/i.test(message)) return "本地数据读取失败，请重试。";
  return diagnosticError(fallback);
}

/** 授权账号与 QQ 登录使用不同的错误提示，避免让用户登错账号。 */
export function describeLicenseError(reason: unknown, fallback = "授权操作失败，请重试。") {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  if (/__TAURI|undefined.*invoke|reading ['"]invoke|IPC/i.test(message)) return "请在应用中完成激活。";
  if (/账号.*密码|口令|AUTH_FAILED|credentials|unauthorized|401/i.test(message)) return "授权账号或密码不正确，请检查后重试。";
  if (/SEAT_LIMIT|席位.*满|名额.*满/i.test(message)) return "设备名额已用完，请解绑一台不再使用的设备。";
  if (/冷却|RATE_LIMITED|限流|频繁|429/i.test(message)) return "操作过于频繁，请按提示时间稍后重试。";
  if (/network|fetch|网络|连接|timeout|超时|dns/i.test(message)) return "无法连接授权服务，请确认服务已启动后重试。";
  if (/ACCOUNT_DISABLED|停用|禁用|封禁/i.test(message)) return "授权账号已停用，请联系账号提供方。";
  if (/ACCOUNT_EXPIRED|到期|过期/i.test(message)) return "授权已到期，可兑换卡密续期后重试。";
  return diagnosticError(fallback);
}

/** 诊断保留错误类别；带凭据和临时签名的内容不呈现在界面。 */
export function diagnosticError(reason: unknown) {
  const message = String(reason ?? "");
  if (/cookie|token|pwd2sig|password|authorization|p_skey|g_tk|skey/i.test(message)) return "详细信息涉及登录或授权凭据，已隐藏。请重新登录或检查授权状态后重试。";
  return message.slice(0, 1200);
}
