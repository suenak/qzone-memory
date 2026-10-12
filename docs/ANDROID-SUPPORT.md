# Android 支持范围

## 运行条件

- 系统：Android 8.0（API 26）及以上。
- 网页组件：实际 Chromium / WebView 内核 111 及以上。厂商组件版本号可能采用自己的命名方式，客户端优先读取 WebView 的内核 UA。
- 发行 APK：同时包含 `armeabi-v7a`、`arm64-v8a`、`x86`、`x86_64`，覆盖常见 32 位和 64 位 ARM、Intel 设备。
- 本次界面面向手机和平板，没有宣称支持 Android TV 遥控器操作。

Tauri 使用设备的系统 WebView，没有随客户端内置独立网页内核。因此只满足 Android 系统版本，仍不能保证原装老网页组件可以运行全部页面。旧组件启动时显示原生更新提示；没有可处理链接的应用商店时进入当前组件的系统设置。参见 [Tauri 官方 WebView 说明](https://v2.tauri.app/reference/webview-versions/)。

Android 8/9 安装网页组件时应使用适配当前系统的版本，不应要求用户安装仅支持更高系统的最新版。Chrome 138 是支持 Android 8/9 的最后一个 Chrome 大版本，见 [Chromium 官方公告](https://groups.google.com/a/chromium.org/g/chromium-dev/c/vEZz0721rUY/m/pUIgqXxNBQAJ)。这不等于本项目已经在该版本 WebView 上完成所有功能测试。

## 配置与发行检查

`src-tauri/tauri.android.conf.json` 的 `bundle.android.minSdkVersion` 和生成项目的 `app/build.gradle.kts` 均设为 26。前者使后续初始化仍能保留系统下限。

GitHub Release 工作流安装并构建四个 Rust Android 目标，生成通用 APK；打包后逐一读取四个 ABI 的 Rust 动态库，任何一个缺失都会停止发布。前端构建显式设置 Chrome 111 目标，保留其他桌面及 Apple 平台原有的编译基线。

## 2026-10-12 验证

- 四种 ABI 的 Rust 动态库编译通过。
- 通用 Debug APK 打包通过，包内实际包含四种 ABI；`aapt` 显示 `sdkVersion:26`、`targetSdkVersion:36`。
- Android 8.0 x86_64 模拟器成功安装和原生启动。镜像内置 WebView 69，原生更新提示与进入组件设置的回退路径验证通过。
- Android 16 x86_64 / WebView 133 安装同一通用包，13 个页面回归检查未发现溢出、导航异常或页面运行错误。
- Android 8 更新 WebView 后的完整业务流程、Android 9 至 15 及其他厂商实体设备尚未完成验证；不能把编译通过等同于所有机型实测通过。

截图及逐页数据保存在工作区根目录 `output/native-device-test/android/`。Android 8 的独立模拟器为 `Shiyi_Android_8`，启动脚本为 `output/android-setup/启动安卓8模拟器.cmd`。

界面验证按 `orchestrate-frontend-design` 主流程执行；其辅助技能 `design-cross-platform-ui` 当前未安装。
