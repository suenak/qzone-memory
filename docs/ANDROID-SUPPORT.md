# Android 支持范围

## 运行条件

- 系统：Android 8.0（API 26）及以上。
- 网页组件：实际 Chromium / WebView 内核 111 及以上。厂商组件版本号可能采用自己的命名方式，客户端优先读取 WebView 的内核 UA。
- 发行 APK：仅包含 `armeabi-v7a`、`arm64-v8a`，覆盖常见 32 位和 64 位 ARM 手机和平板。不发行 Intel 架构 APK。
- 本次界面面向手机和平板，没有宣称支持 Android TV 遥控器操作。

Tauri 使用设备的系统 WebView，没有随客户端内置独立网页内核。因此只满足 Android 系统版本，仍不能保证原装老网页组件可以运行全部页面。旧组件启动时显示原生更新提示；没有可处理链接的应用商店时进入当前组件的系统设置。参见 [Tauri 官方 WebView 说明](https://v2.tauri.app/reference/webview-versions/)。

Android 8/9 安装网页组件时应使用适配当前系统的版本，不应要求用户安装仅支持更高系统的最新版。Chrome 138 是支持 Android 8/9 的最后一个 Chrome 大版本，见 [Chromium 官方公告](https://groups.google.com/a/chromium.org/g/chromium-dev/c/vEZz0721rUY/m/pUIgqXxNBQAJ)。这不等于本项目已经在该版本 WebView 上完成所有功能测试。

## 配置与发行检查

`src-tauri/tauri.android.conf.json` 的 `bundle.android.minSdkVersion` 和生成项目的 `app/build.gradle.kts` 均设为 26。前者使后续初始化仍能保留系统下限。

GitHub Release 与 nightly 工作流仅安装、构建两个 ARM Rust 目标，生成通用 APK；打包后检查两种 ARM 动态库，并拒绝包含 `x86` / `x86_64` 动态库的发布包。Gradle Release 也限制为 ARM，禁用 Intel Release 变体。前端构建显式设置 Chrome 111 目标，保留其他桌面及 Apple 平台原有的编译基线。

正式 APK 的本地构建命令：

```bash
npx tauri android build --target aarch64 armv7 --apk
```

## 开发期模拟器验收

模拟器只用于开发验收，使用 Debug 包，不要求正式包支持模拟器架构：

```bash
npx tauri android build --debug --target x86_64 --apk
# 或连接／启动模拟器后：
npx tauri android dev
```

Debug 保留 x86 / x86_64 开发目标。模拟器检查布局、交互、系统版本和 WebView；ARM 正式包的安装与业务流程应在 ARM 设备上验收。

## 架构调整验证

- Gradle 配置与构建任务图通过：Universal Release 仅触发 ARM／ARM64 的 Rust 构建，x86_64 Debug 任务仍可用。
- 使用本机已有原生库验证 Release 合并输出，实际仅包含 `arm64-v8a`、`armeabi-v7a`，旧 x86／x86_64 JNI 缓存被排除。
- Release 与 nightly YAML 已解析检查，构建目标及 APK 校验均限定 ARM。此处未重新编译完整 APK，也未修改已发布的 1.2.4 安装包。

## 2026-10-12 历史验证（调整发行架构之前）

- 四种 ABI 的 Rust 动态库编译通过。
- 通用 Debug APK 打包通过，包内实际包含四种 ABI；`aapt` 显示 `sdkVersion:26`、`targetSdkVersion:36`。
- Android 8.0 x86_64 模拟器成功安装和原生启动。镜像内置 WebView 69，原生更新提示与进入组件设置的回退路径验证通过。
- Android 16 x86_64 / WebView 133 安装同一通用包，13 个页面回归检查未发现溢出、导航异常或页面运行错误。
- Android 8 更新 WebView 后的完整业务流程、Android 9 至 15 及其他厂商实体设备尚未完成验证；不能把编译通过等同于所有机型实测通过。

截图及逐页数据保存在工作区根目录 `output/native-device-test/android/`。Android 8 的独立模拟器为 `Shiyi_Android_8`，启动脚本为 `output/android-setup/启动安卓8模拟器.cmd`。

界面验证按 `orchestrate-frontend-design` 主流程执行；其辅助技能 `design-cross-platform-ui` 当前未安装。
