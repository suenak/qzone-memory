# 安装包体积优化（2026-10-14）

| 产物 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| Windows x64 NSIS | 5,865,972 字节（5.59 MiB） | 4,513,628 字节（4.30 MiB） | 23.05% |
| Android ARM / ARM64 APK | 47,179,436 字节（44.99 MiB） | 12,137,814 字节（11.58 MiB） | 74.27% |

Windows 比较使用上一轮包含客户端内下载功能的本地验证包。APK 比较使用已发布 1.2.6 与当前源码的未签名产物，当前源码还包含新的更新下载功能；不是严格相同源码的 A/B。正式签名后 APK 会略增。

## 改动

- Rust Release 采用 `opt-level="s"`、Thin LTO、单个 codegen unit，清理调试信息。保留原来的 panic/unwind 行为。桌面与移动端共用该配置。
- Android Release 压缩原生库，启用未使用资源清理；ARM / ARM64 均保留，发行包继续排除 x86 / x86_64。
- 原先 Debug 内的 `packaging` 实际落到全局 Android 配置，导致 Release 也保留符号。现在通过 Debug variant 设置保留规则，Release 正常 strip，JNI 动态导出保留。
- Gradle 从 `ANDROID_NDK_HOME` / `NDK_HOME` 选择与 Rust 相同的 NDK。避免本机只安装 27.2、Gradle 默认寻找 27.0 时跳过 strip。CI 原来的 27.0 环境继续适用。
- Android ELF 链接采用 16 KiB 对齐。压缩 APK 与 ELF 对齐是两件事，需要分别检查。

APK 下载更小，但安装时会解压原生库，因此安装空间可能增加。这是直接分发 APK 的下载体积取舍。[Android 官方说明](https://developer.android.com/guide/practices/page-sizes)

## 验证

- Windows 安装包重新构建成功，主程序从 23,336,448 字节降至 16,052,224 字节。
- 86 项 Release 配置 Rust 测试通过；前端构建、Rust check、fmt 和差异检查通过。
- Android 两种架构的 Release 原生库编译成功，Gradle Release APK 打包与 Debug manifest 检查通过。
- 最终 APK ZIP 校验与 zipalign 检查通过；只含 ARM / ARM64，min SDK 26、target SDK 36，manifest 的 `extractNativeLibs=true`。
- 两份库均为压缩条目，16 KiB LOAD 对齐，JNI 启动导出保留，静态 `.symtab` / `.strtab` 已清除。

本机缺少符号链接权限，采用复制已编译原生库再运行 Gradle 的方式完成 APK 验证。macOS / iOS 尚未在本机重打；未做 ARM 物理设备安装验收。本项随 1.2.7 发布上线。

## 本地产物

产物仍显示 1.2.6，仅用于验证。路径相对仓库根目录：

- Windows：`../output/package-size-2026-10-14/qzone-memory_1.2.6_x64-size-test-setup.exe`
- Android（未签名）：`../output/package-size-2026-10-14/qzone-memory_1.2.6_android-size-test-unsigned.apk`。正式安装包须走既有发行签名流程，不能把本地产物作为可覆盖安装的正式 APK。
- 大小、SHA-256 与原生库检查结果：`../output/package-size-2026-10-14/comparison.json`。

构建参数参考：[Cargo Release profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)。
