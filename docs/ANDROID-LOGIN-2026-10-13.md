# Android 登录与布局修复

## 行为

所有 QQ 登录入口先查询软件授权；未激活、失效或查询失败时转到软件授权页，不发起二维码或 QQ 登录请求。已有本地记录仍可查看。已有授权账号用账号密码激活；卡密在软件授权页兑换，有效授权无需每次重复输入卡密。

Android 默认走原生 QQ 官方移动登录页。桌面端保留二维码与网页登录。官方页的可信 QQ scheme 可跳转 QQ，不接收任意 intent 或外部 URL。登录页没有 JavaScript 接口，Cookie 只经原生桥交给 Rust，Rust 只接受最小会话 Cookie。取消和退出清理登录页 Cookie。

更多菜单提供完整可滚动高度；窄屏任务登录提醒将按钮放到说明下方；弹窗由外层内容区统一滚动。Release 只保留 ARM / ARM64，x86 / x86_64 排除规则仅作用于 Release variant，Debug 支持模拟器。

## 无需注册 QQ 互联的登录方式

Android 使用内置原生 WebView 打开 QQ 空间官方手机入口 `https://h5.qzone.qq.com/mqzone/index`，由官方跳转到手机登录页。用户在官方页面使用账号密码登录；页面提供“一键登录”时，可以打开已安装的 QQ。应用不接触或代填 QQ 密码，不要求复制 Cookie，不使用第三方 AppID。

官方移动登录脚本的“一键登录”发出 `wtloginmqq://ptlogin/qlogin`，可能通过 iframe 发起。原生桥接仅接收可信官方登录页的该协议，以及主页面发出的 QQ 协议。未安装或无法打开 QQ 时，提示使用官方网页账号密码登录。Android 中没有注入通用 JavaScript 接口，没有自定义 OAuth 回调接收器。

打开 QQ 只是跳转成功，不能当作空间登录成功。应用等待自身登录页收到有效的 `p_skey` 和数字 QQ 号；仅在 Rust 建立有效空间会话后显示登录成功。如果 QQ 将用户带入它自己的浏览器而没有返回本应用的空间会话，应返回本应用并使用官方网页登录。风控、验证码与设备限制由腾讯页面处理。

已移除 QQ 互联 SDK、AppID 占位、OAuth 回调 Activity、SDK 安装脚本、构建依赖和 CI 环境配置。不需要注册应用，也不需要在构建环境填写 AppID / AppKey。

## 验收范围

Android 16 x86_64 模拟器使用 Debug APK，另有 Chromium 窄屏检查。软件授权入口与原生守卫在模拟器 WebView 验证；已授权 UI 由浏览器 IPC 测试模拟，不代表腾讯实际登录成功。没有连接实体手机。QQ 账号实际登录和客户端回跳尚未完成验收。截图在工作区 `output/playwright/android-*`。

设计采用 orchestrate-frontend-design 与 frontend-design；design-cross-platform-ui 未安装，按现有 token 与主流程检查。

已通过前端构建、cargo fmt/check、73 项 Rust 测试、23 项 license-core 测试，原生 Kotlin 与 Debug APK 构建。QQ 互联 SDK 已移除。Debug APK 原生库为 x86_64；Release 合并原生库为 arm64-v8a 和 armeabi-v7a。Android 16 模拟器实际检查了授权跳转、原生授权守卫、任务提醒、更多菜单贴底和系统返回键；320×640、390×760、900×420 的浏览器布局与最后一项菜单可达性通过。

开发期 Debug APK 通过 ADB reverse 使用本机 Vite 服务；不应分发给最终用户，且没有进行 Release 发布。

只读网络验证确认 `https://h5.qzone.qq.com/mqzone/index` 会跳转腾讯“手机统一登录”页（HTTP 200，带登录表单和一键登录入口）。使用该官方入口生成最新移动登录参数，不使用返回“网络繁忙”的 xlogin/style=9 地址。此检查没有登录 QQ 账号，也不证明 SSO 或历史数据读取成功。

无 QQ 互联版本的 Debug APK 构建和安装通过；3 项安卓跳转策略测试通过，覆盖官方 iframe 一键登录、来源域名边界、禁止任意 intent 和非登录 wtloginmqq 操作。APK DEX 未包含 QQ SDK 主类。
