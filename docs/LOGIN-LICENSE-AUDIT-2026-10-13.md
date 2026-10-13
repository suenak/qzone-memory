# 多平台登录授权排查

## 结论

Windows、macOS、Linux、Android、iOS 的普通登录统一经过 `useAuthStore.ensureLoginAccess()`，二维码刷新、网页登录开始也独立检查软件授权。后端的扫码开始、扫码轮询、网页登录开始与网页登录轮询均先调用 `require_archive_access()`，没有按平台或 Debug/Release 跳过。

发现共同遗漏：`restoreSession()` 原先在启动或焦点恢复时直接读取 QQ 会话，并获取昵称头像；`get_login_status` 原先没有软件授权守卫。前端现先刷新软件授权，不能恢复时不读取 QQ 会话、不获取资料；后端也先检查授权再恢复会话。未激活或无法读取授权时不会沿用旧的 canArchive=true。

普通登录被拦截时引导软件授权页。启动时的会话恢复被拦截不自动跳转，允许用户先查看和导出本地内容；已有本地数据的读取和导出仍不依赖授权。

“没有再次要求卡密”不一定是问题：卡密用于给授权账号兑换时长或设备名额，设备已经持有有效签名授权时，无需每次登录 QQ 重复兑换。active 与允许的 grace 状态可登录；notActivated、invalid、restricted 和状态查询失败应拦截。超过离线宽限期才进入 restricted。

## 验证

| 平台 | 四个前端入口、六种授权状态 | 后端代码守卫 | 原生运行验证 |
| --- | --- | --- | --- |
| Windows | 24 项模拟通过 | 已检查共同 Rust 实现 | 本机 Rust 编译及测试 |
| macOS（Apple/Intel） | 24 项模拟通过 | 已检查共同实现与 cfg 分支 | 未实机运行 |
| Linux | 24 项模拟通过 | 已检查共同实现与 cfg 分支 | 未实机运行 |
| Android | 24 项模拟通过 | 已检查原生移动登录分支 | Android 16 模拟器 Debug |
| iOS | 24 项模拟通过 | 已检查共同实现与 cfg 分支 | 未实机运行 |

模拟测试检查 restoreSession、openLogin、refreshQrCode、startWebLogin 四个入口，对每个平台分别使用 notActivated、invalid、restricted、授权查询异常、active、grace 六种状态，共 120 项。每个用例都先放入过时的 active 缓存，确认刷新后的真实状态起决定作用；不允许登录时未发起 get_login_status、start_qr_login 或 open_web_login。有效状态仍能发起正确的平台登录流程。

前端构建、cargo fmt/check、73 项 Rust 测试、23 项 license-core 测试通过；后端已有测试确认未激活、过期、设备解绑和账号停用时不能开始新任务，而本地读取保持可用。

此报告对应当前工作区源码与开发包。未重新发布所有平台的 Release 安装包，不能推断此前安装的客户端已包含修复。

安卓原生 Debug APK 重新安装后，在未激活状态直接调用 get_login_status、start_qr_login、poll_qr_login、open_web_login、check_web_login 和 sync_cookies_to_webview 六个命令，全部由软件授权守卫拒绝。相册回收站的独立密码验证入口也已检查，三个相关原生命令均以 require_archive_access 为首条语句。
