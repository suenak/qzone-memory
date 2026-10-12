# 客户端设备与布局验证（2026-10-12）

## 验证范围

本次检查界面排版、原生启动、导航、主题、系统边距和软键盘交互。原生客户端使用真实 Rust 接口和空数据，未登录真实 QQ 账号，未执行授权激活、恢复任务或远程资料同步。因此本记录不能证明这些业务流程已通过端到端测试。

| 环境 | 实际完成 | 限制 |
| --- | --- | --- |
| 本机 Windows / WebView2 | 隔离副本原生启动；13 个路由的浅色、深色检查；Ctrl K 聚焦搜索 | 使用独立应用标识、凭据服务名和空数据；不是正式安装包验收 |
| Android 16 x86_64 模拟器 / WebView 133.0.6943.137 | 安装本次源代码生成的 Debug APK；13 个路由的竖屏、横屏、深色检查；真实 IME 与 Android 返回键；挖孔边距、三键导航、130% 系统字体 | 模拟器不是实体手机；只覆盖 Android 16 和该 WebView 版本 |
| Chromium 浏览器 | 65 组尺寸与路由检查；10 项交互检查；24 组 Android/iOS 标识下的横屏和平板布局检查 | 浏览器使用独立界面测试数据；不代表这些平台的原生测试 |
| macOS、Linux、iPhone、实体安卓手机 | 未完成原生实机验证 | 当前没有可用设备 |

## 本次修复

- 移动端横屏或平板宽度超过桌面断点时，继续使用触控导航。
- 原生 Android 父容器处理系统栏、挖孔和 IME 边距，并将已处理的边距归零后继续传给 WebView，避免重复留白。
- 移动端同时比较输入前高度和可见视口高度，适配原生层缩小布局视口的情况。键盘弹出时收起底部导航；键盘关闭后恢复，不清除输入焦点。
- Android 返回键优先通过 Escape 关闭 PrimeVue 模态弹层。没有模态弹层时，交回 Tauri 原有的历史返回或退出逻辑。
- 授权页根据移动平台保持紧凑排版；宽横屏采用介绍与表单并列，竖屏保持单列。
- 登录弹窗改用动态视口高度限制。

边距处理参考：[Android 官方 WebView 边距说明](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)。

## 结果与证据

最终 Android 竖屏、横屏及深色横屏的逐页记录均未发现横向溢出、无效导航布局或页面运行异常。横屏补充条件包含三键导航、挖孔模拟和 130% 系统字体。

软键盘验证中，密码输入框保持焦点，底部坐标约 532 CSS px，小于可见高度 554 CSS px，底部导航隐藏；返回关闭键盘后可见高度恢复到 867 CSS px，导航恢复。打开“更多页面”后按 Android 返回键，抽屉关闭且当前路由保持不变。

证据保存在工作区根目录的 `output/native-device-test/`，不进入公开仓库：

- `windows/light/results.json`、`windows/dark/results.json`：Windows 原生逐页记录及截图。
- `android/final-portrait/results.json`：最终 APK 竖屏逐页记录及截图。
- `android/final-landscape/results.json`：最终 APK 横屏补充条件的逐页记录及截图。
- `android/final-dark-landscape/results.json`：最终 APK 深色横屏逐页记录及截图。
- `android/final-landscape-system.png`：包含系统栏和三键导航的横屏截图。
- `android/final-password-keyboard.png`：密码输入与真实软键盘截图。
- `android/shiyi-1.2.3-x86_64-debug.apk`：用于模拟器的 Debug APK，不是 ARM 手机安装包或正式发布包。

## 本机构建与模拟器

已配置独立 AVD `Shiyi_Android_16`，使用已有 Android 16 Google Play x86_64 镜像和 WHPX 加速。因本机 Vulkan 兼容问题，启动脚本使用软件图形渲染，并关闭可选统计收集。独立模拟器内蓝牙已关闭，以避开镜像中的蓝牙进程异常。

本机增加 Android 命令行工具、NDK 27.2.12479018 和 Rust `x86_64-linux-android` 目标。JDK 21 仅用于本次构建进程，没有更改全局 Java 默认版本。

Windows 未提供创建符号链接权限，Tauri CLI 因此在 Rust 编译后的库链接步骤失败。本次复制已编译库到生成目录，再由 Gradle 排除重复 Rust 构建任务完成 APK，最终 Gradle 打包成功。该测试路径不代表常规一键打包命令已经消除环境限制。Kotlin 编译使用进程内模式避开本机守护进程故障。

启动脚本位于工作区根目录 `output/android-setup/启动安卓模拟器.cmd`。模拟器中已安装“拾忆”，可从应用列表打开。

设计检查采用 `orchestrate-frontend-design` 流程；其辅助技能 `design-cross-platform-ui` 当前未安装，已使用主流程的质量检查要求完成本次验证。
