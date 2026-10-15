# 客户端安装后显示名

用户可见的应用名称统一为 **拾忆**。技术名称保留 ASCII，应用标识保持 `top.ehre.qzonearchive`，避免改名影响登录资料、授权和已保存的数据。

| 平台 | 用户可见名称 | 配置入口 |
| --- | --- | --- |
| Windows | 桌面与开始菜单快捷方式、系统安装列表、程序文件属性显示“拾忆” | `tauri.conf.json`、`nsis-installer.nsi`、`nsis-hooks.nsh` |
| macOS | 应用包与应用名称为“拾忆” | `tauri.conf.json` 的 `productName` |
| Android | 桌面与系统应用信息显示“拾忆” | `tauri.android.conf.json`、Android `strings.xml` |
| iOS | 主屏幕名称与 Bundle 名称为“拾忆” | `tauri.ios.conf.json` 引用 `Info.ios.plist` |
| Linux | 应用启动器显示“拾忆”，软件包仍使用 `qzone-memory` | `tauri.linux.conf.json`、`linux.desktop` |

Windows、macOS 和 Linux 程序文件名保留 `qzonearchive`，iOS 项目与可执行文件保留 `qzone-memory`。窗口标题继续说明用途：“拾忆 · QQ 空间说说恢复”。

## Windows 安装识别兼容

Tauri 默认使用 `productName` 同时生成显示名及 NSIS 注册表键。直接改名会使新安装程序找不到旧版，因此使用带 MIT 许可证的 CLI 2.11.4 原始模板，增加稳定的 `INSTALLIDENTITY=qzone-memory`：

- NSIS 卸载项键仍为 `Software\Microsoft\Windows\CurrentVersion\Uninstall\qzone-memory`，显示值则为“拾忆”。
- 安装位置键与默认安装目录保留原有 `qzone-memory` 名称，覆盖安装继续读取旧位置。
- 应用 Bundle ID 和 MSI UpgradeCode 均保持不变。
- 安装完成后处理旧 `qzone-memory.lnk`：只有指向本安装目录程序的快捷方式才会重命名或去重，不覆盖指向其他程序的同名快捷方式。
- 英文 MSI 使用支持中文名称的代码页 936；界面语言仍为英文，避免默认 1252 代码页导致打包失败。

模板与 CLI 版本固定对应。升级 `@tauri-apps/cli` 时，需要同步比较上游模板，保留 `INSTALLIDENTITY`、旧 MSI 名称匹配和安装目录兼容改动，并重新验证安装包。模板原文来源与许可证见 `THIRD_PARTY_NOTICES.md`。

## 2026-10-15 验证

- 四组合并后的 Tauri 配置通过本地 CLI JSON Schema 校验；Android、iOS 和 Linux 显示名资源核对通过。
- Android `strings.xml` 通过 SDK 36 的 AAPT2 编译。
- Windows 生产构建与 NSIS 打包成功；程序及安装程序的 ProductName、FileDescription 均为“拾忆”。生成的 NSIS 脚本保留旧安装识别键、Bundle ID 和程序文件名。
- 中文及英文 MSI 都生成成功，通过 Windows Installer 只读数据库接口确认 ProductName 为“拾忆”，UpgradeCode 与旧版一致。
- 在工作区隔离目录运行四种真实快捷方式迁移情形：重命名、同目标去重、保留其他目标的同名快捷方式、忽略不属于本程序的旧链接，全部通过。测试不安装正式客户端，也不改动系统中的正式快捷方式。
- `git diff --check` 通过。本次没有改动 Rust 业务代码；生产构建包含 Rust 编译和前端类型检查。

本机 NSIS 安装包保存在工作区 `output/client-display-name-1.2.8/拾忆_1.2.8_x64-setup.exe`，约 4.33 MiB，SHA-256：`39683EEEB014B7778DAE0F2298D1F1B34A6E38186F6F2C9C104F7932759D35FF`。这是未发布的本地 1.2.8 构建，包含此前手机页面的调整。

尚未替换已安装客户端或执行正式覆盖安装；未生成新的 Android、Apple 或 Linux 包，也未完成这些平台的安装实测。已经安装的旧版本，需要安装后续新包后才会应用新的显示名；系统固定的旧快捷方式可能需要重新固定。
