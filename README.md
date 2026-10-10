# 拾忆 · qzone-memory

[![Rust](https://img.shields.io/badge/Rust-1.77%2B-orange)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue)](https://v2.tauri.app/)
[![Vue](https://img.shields.io/badge/Vue-3.5-green)](https://vuejs.org/)
[![License](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

将 QQ 空间动态、照片、视频与互动记录安全归档到本地的桌面 / 移动端工具。

上游作者：[xiaosu19](https://github.com/xiaosu19)（本项目派生自其维护的 `QQ-Zone-Restore-Archive`）

项目地址：[suenak/qzone-memory](https://github.com/suenak/qzone-memory)

> [!IMPORTANT]
> 本项目是基于 [Gaoshu705/QzoneArchive](https://github.com/Gaoshu705/QzoneArchive) 的 GPLv3 二次开发版本，并参考了 [LibraHp/GetQzonehistory](https://github.com/LibraHp/GetQzonehistory)、[ShunCai/QZoneExport](https://github.com/ShunCai/QZoneExport)、[salt-fishes/qzone-archiver](https://github.com/salt-fishes/qzone-archiver)、[11273/QzonePhoto](https://github.com/11273/QzonePhoto) 与 [Gu-Heping/onebot-qzone](https://github.com/Gu-Heping/onebot-qzone) 的历史取数、空间资料接口、评论正文和昵称解析思路。QZoneExport 参考实现遵循 Apache-2.0；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。原项目作者、参考项目作者和腾讯公司均不对本分支提供背书或担保。

> [!WARNING]
> 本项目不是腾讯、QQ 或 QQ 空间官方产品。所谓“恢复已删除说说”仅指：当已删除内容仍残留在点赞、评论、回复等互动记录中时，尝试还原其中可取得的正文和媒体信息；没有互动痕迹、已被服务端彻底清除、无权访问或接口不再返回的内容无法恢复，也不保证归档结果完整。请仅处理本人账号或已获得充分授权的内容，并自行承担账号限制、第三方接口变化、数据遗漏和本地数据保管风险。

如果本项目对你有帮助，可以支持并 Star [suenak/qzone-memory](https://github.com/suenak/qzone-memory)。

## 功能

- **多来源恢复**：合并当前可见说说、旧历史消息残留和移动端互动通知，尽量找回仍被 QQ 接口保留的本人说说、好友动态与留言线索
- **结构化互动**：还原点赞用户、评论、回复人与被回复人，补全可取得的昵称，并提供联系人排行和评论往来视图
- **深度扫描与续传**：顺序探测历史记录，在最后命中后继续验证空尾；被限流或中断时保留断点和已经写入的数据
- **资料独立归档**：相册、相册照片、独立视频、留言板与 QQ 空间网页端旧收藏分别分页同步，不与说说混在一起
- **媒体整理**：按年份浏览说说照片和视频，保留多个可用清晰度候选，过滤头像、点赞图标和空间装饰资源
- **本地优先**：SQLite 数据库、媒体缓存和导出文件都保存在用户设备；登录会话只进入操作系统安全凭据库
- **检索与导出**：支持全文搜索、年份筛选、时间排序、批量管理与离线 HTML 导出
- **现代桌面界面**：浅色 / 深色 / 跟随系统三态主题，统一设计令牌，时间轴式说说浏览，全屏图片灯箱，长列表增量加载
- **跨平台发行**：提供 Windows、macOS（Intel / Apple 芯片）、Linux、Android、iOS 未签名包与 NixOS 构建

完整版本历史请查看 [CHANGELOG.md](CHANGELOG.md)。

## 界面设计

界面围绕一个原则构建：**让内容成为主角，界面退到后面**。工具本身应该消失在回忆后面。

- **视觉语言**：克制的天空蓝紫主色，低饱和中性灰阶，精致的圆角与分层阴影。唯一使用的暖色留给年份标记、时间轴节点与回忆标语——只有确实承载怀旧语义的地方才配得上它。
- **明暗双主题**：浅色为默认，完整支持深色，并可跟随系统实时切换。所有颜色都来自 `src/styles/tokens.css` 中的设计令牌，不存在散落的硬编码色值。
- **信息架构**：左侧导航按“回忆 / 空间资料 / 管理与设置”分组，顶部工具栏承载页面标题、全局搜索、主题切换与账号菜单；评论往来等次级内容在右侧抽屉中展开。
- **状态完整**：每个数据区域都具备加载骨架、空状态、错误状态与成功反馈。空状态会解释“为什么这里什么都没有”并给出下一步，而不是只显示一个灰色图标。
- **不做假数据**：归档任务没有可预知的总量，因此界面显示的是不定长进度动画配合真实的已保存条数，而不是编造一个百分比。

设计约定与响应式要求的完整说明见 [docs/UI-REFACTOR-SPEC.md](docs/UI-REFACTOR-SPEC.md)。

## 下载与安装

请从本仓库的 [Releases](https://github.com/suenak/qzone-memory/releases) 下载与系统匹配的安装包：

- Windows：NSIS 安装程序（`.exe`）
- macOS：Intel `x64` 或 Apple 芯片 `aarch64` 安装镜像（`.dmg`）
- Linux：AppImage、Debian/Ubuntu `deb`、Fedora/openSUSE `rpm`
- Android：通用 `apk`
- iOS：未签名 `ipa`，需要自行签名后安装
- NixOS：包含 Nix closure 的离线安装包

macOS 包采用临时签名，首次打开若被 Gatekeeper 拦截，请在“系统设置 → 隐私与安全性”中确认打开。iOS 包未签名，不能直接安装或提交 App Store。

## 首次使用

首次启动需要同意《免责声明与使用须知》。已有本地备份可直接查看；开始新的备份前，请在“设置 → 软件授权”激活本设备。

- 一个账号可在最多 3 台设备上使用，**不区分电脑或手机**，共用同一个名额池。
- 更换设备时可在「设置 → 软件授权 → 管理设备」自助解绑，每 30 天一次。
- 激活后凭证保存在本地并经签名校验，**离线仍可正常使用**。网络不可达时进入宽限期，超过宽限期后仅限制**新建归档任务**,查看、搜索与导出已有数据始终可用。

官方构建内置了生产授权服务器与其 Ed25519 签名公钥。这两项不在源码里，而是构建期从配置读入：本仓库的 `src-tauri/qza.config.json` 放的是占位值，打包机上另有一份不入库的 `src-tauri/qza.config.local.json` 放真实值。自行构建若指向别的服务端，最省事的做法是照 `qza.config.json` 的格式建一份 `qza.config.local.json`，四项一起换——只换地址不换公钥，签发的凭证会全部校验失败。详见 [自建授权服务](#自建授权服务)。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri 2 |
| 前端 | Vue 3 + TypeScript + Vite |
| UI 组件 | PrimeVue 4（浮层与表单控件）+ 自有设计系统组件 |
| 图标 | Lucide |
| 状态管理 | Pinia |
| 样式 | 原生 CSS 设计令牌 + 组件级 scoped 样式 |
| 后端数据库 | SQLite (rusqlite) |
| HTTP 客户端 | reqwest (rustls-tls) |
| 授权校验 | Ed25519 签名凭证（`license-core`,独立可测） |
| 打包 | NSIS / DMG / AppImage / deb / rpm / APK / unsigned IPA / Nix closure |

## 开发

### 前置要求

- [Rust](https://www.rust-lang.org/tools/install) 1.77+
- [Node.js](https://nodejs.org/) 20+
- Windows: [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 10+ 自带）
- Android: [Android Studio](https://developer.android.com/studio) + Android SDK + NDK

### 启动开发环境

```bash
# 安装前端依赖
npm install

# 启动开发服务器（桌面端）
npm run tauri dev

# Android 构建
npm run tauri android dev
```

### 构建

```bash
# Windows NSIS 安装包
npm run tauri:build:windows

# Windows NSIS + MSI
npm run tauri:build:windows:all

# Android APK
npm run tauri android build
```

### 验证

```bash
npm run build                # 前端类型检查 + 构建
cargo fmt --check            # Rust 格式
cargo check                  # Rust 类型检查
cargo test --manifest-path src-tauri/license-core/Cargo.toml   # 授权校验逻辑单元测试
```

### 项目结构

```
├── docs/                   # 设计约定文档
├── src/                    # Vue 前端
│   ├── views/              # 页面组件
│   │   ├── DashboardView   # 回忆总览：统计、互动排行、回忆时光
│   │   ├── ArchivesView    # 说说时间轴：浏览、搜索、导出、删除
│   │   ├── MediaView       # 说说媒体时光轴
│   │   ├── LibraryView     # 相册 / 照片 / 视频 / 留言板 / 收藏
│   │   ├── ContactsView    # 联系人与评论往来
│   │   ├── TasksView       # 归档任务、进度与断点续传
│   │   ├── RecycleBinView  # 相册回收站恢复
│   │   ├── SettingsView    # 外观、账号、数据与关于
│   │   └── ActivationView  # 授权激活
│   ├── components/ui/      # 设计系统基础组件
│   ├── composables/        # 组合式函数
│   ├── stores/             # Pinia 状态管理
│   ├── utils/              # 后端命令绑定与工具函数
│   ├── layouts/            # AppShell（侧边栏 + 工具栏 + 内容区）
│   ├── router/             # 路由配置
│   └── styles/             # tokens.css（设计令牌）+ base.css（重置与组件库适配）
├── src-tauri/              # Rust 后端
│   ├── license-core/       # 授权凭证校验（纯逻辑，可独立单测）
│   └── src/
│       ├── main.rs         # 入口
│       ├── lib.rs          # Tauri 命令注册与初始化
│       ├── license.rs      # 设备身份、凭据存储、激活通信、命令守卫
│       ├── qlogin.rs       # QQ 登录（二维码 + 网页）
│       ├── qzone.rs        # QQ 空间接口
│       └── archive.rs      # 归档引擎 + 数据库
└── src-tauri/capabilities/ # Tauri 权限配置
```

## 原理

### 数据来源与完整度

归档会合并三类来源：QQ 空间当前可见说说接口、旧历史消息接口，以及移动端互动列表接口 (`mobile.qzone.qq.com/get_feeds`)。可见说说会使用接口返回的 `total` 逐页对账；历史残留采用顺序扫描并验证最后一次命中后的 6,000 个记录位置；其他动态与留言主要来自互动通知和旧历史卡片。多来源记录按说说 ID、用户 QQ 号和事件时间合并，搜索在整个 SQLite 归档中执行，不受当前分页限制。若腾讯 WAF 临时拦截移动端互动接口，已经取得的桌面通道数据仍会保存并明确提示未补齐的互动；本人可见说说为空时，程序会先从 QQ 资料接口确认本人昵称，再解析历史卡片。

旧历史卡片显示的是点赞或评论发生时间，不是说说发布时间。对于仍保留标准 QQ 说说 ID 的记录，程序会从 ID 中校验账号并解码原始发布时间；无法验证的记录才保留接口时间。本地现有样本已经验证到 2018 年，但是否存在 2017 年记录必须以该账号在本次深度扫描中实际返回的数据为准。

图片和视频会保留接口返回的多个清晰度候选地址，并过滤头像、点赞图标和空间装饰图。部分旧资源的原图或视频签名已经被 QQ 服务端清理或过期时，只能保存仍可访问的低清地址或封面。

界面中的最早年份只代表本次请求在已验证范围内最早命中的记录，不能据此断言账号在更早年份没有发布内容。**没有被点赞或评论过、已被服务端彻底清除、超出接口保留范围或接口当前拒绝返回的动态无法恢复**。其他动态与留言也没有权威的服务端总数，因此只能报告本次接口返回量，不能保证穷尽。

### 登录方式

- **二维码登录**：调用 QQ 空间移动端扫码登录流程，全程不接触密码
- **网页登录**（桌面端）：打开独立窗口加载 QQ 登录页，通过 WebView Cookie API 提取登录凭证

登录凭证（Cookie）不会写入 SQLite、浏览器本地存储或日志。桌面端在用户登录成功后将必要会话加密保存到操作系统安全凭据库，用于下次启动恢复登录；退出登录或“删除所有数据”会清除该凭据。QQ 会话自身过期后仍需重新登录。

### 关于授权

客户端采用 GPLv3 开源，本地校验属于**体验层**:它提示设备授权状态、让离线用户继续使用已有数据，但它不是安全边界——任何人都可以编译出跳过本地校验的版本。真正的边界是服务端签发的 Ed25519 签名凭证，它无法被伪造。

因此本项目不会、也不应该把用户已经归档到本地的数据与授权状态绑定。授权过期只会限制新建归档任务，**绝不会锁住你已经拿到手的数据**。

## 注意事项

- 请只归档本人或已获得授权的账号内容
- 归档过程中不要切换 QQ 客户端账号，否则可能有冻结风险
- 出现频繁提示时建议换个时间段继续，程序支持断点续传
- QQ 的视频签名有时效性，过期后需要重新归档以更新视频地址
- 数据默认保存在应用数据目录，建议定期将重要资料额外备份

## 免责声明

本软件是用于整理和备份个人 QQ 空间资料的本地工具，与腾讯公司、QQ、QQ 空间及其关联主体不存在隶属、授权、合作关系。使用者应在合法授权范围内使用，并自行承担使用风险。详见应用内《免责声明与使用须知》。

## 友情链接

* [LINUX DO](https://linux.do/) - 新的理想型社区

## 许可证

本项目采用 [GPLv3](LICENSE) 许可证。


## 公开源码范围

本仓库公开恢复与备份客户端的 Vue/Tauri 源码、构建配置、依赖锁文件、Android 工程和开发文档，并按 GPLv3 发布。原作者署名、上游项目说明和许可证继续保留。

客户端的授权页面、凭证校验与接口调用是客户端源码的一部分，因此包含在此。独立的授权管理服务、管理后台、卡密生成、账号数据库、更新服务和服务端私钥不包含在本仓库。内置验签公钥不是私钥。

当前公开的是 2026-10-10 的客户端源码；线上分发的安装包是 1.2.1，由这份源码之前的一个版本构建。两者之间的差异只有一处：四项部署常量的注入方式从源码常量改为构建期配置文件（目的就是让公开仓库不含生产值），默认配置下行为完全相同。也就是说这份源码比线上包新一个修订，但功能代码一致。与该安装包逐行对应的源码快照保存在标签 **`source-2026-10-10`**，需要「对应源码」时检出这个标签即可。分发安装包时，应提供与该安装包对应的源码版本及构建说明，不能用不同版本的源码替代。详见 [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)。

授权服务器地址、内置验签公钥、更新清单地址与官网下载页这四项部署常量不写在源码里，而是由 `src-tauri/build.rs` 在构建期从配置读出并生成 `qza_config.rs`。取值优先级：编译期环境变量 → `src-tauri/qza.config.local.json`（不入库）→ `src-tauri/qza.config.json`（入库，占位值）。本仓库带的是占位值，所以克隆下来能编译、能运行，但无法激活——这是刻意的：占位构建会明确提示「本构建未配置授权服务器」，而不是让用户对着一个笼统的网络错误猜原因。本仓库不包含服务端私钥、管理后台、卡密生成与账号数据库。已有数据访问不需要授权；联网备份需要匹配服务端公钥的授权凭证。

CI 中的 Android APK 使用每次构建生成的临时测试密钥；该密钥不能用于覆盖安装正式签名的应用。正式发布请使用自行保管的签名密钥，勿提交密钥和密码。

## 自建授权服务

客户端去哪里激活、信任哪把公钥，由四项部署常量决定；它们不写在源码里，而是构建期从配置读出（取值优先级见上一节）。要指向自己的服务端，在本机建一份 `src-tauri/qza.config.local.json`，照 `src-tauri/qza.config.json` 的格式填：

```json
{
  "QZA_LICENSE_SERVER": "https://你的授权服务地址",
  "QZA_LICENSE_PUBLIC_KEY": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "QZA_UPDATE_ENDPOINT": "https://你的授权服务地址/api/v1/update/latest",
  "QZA_DOWNLOAD_PAGE": "https://你的官网/"
}
```

公钥必须与服务端签发凭证所用的私钥配对，否则客户端会拒绝每一张凭证。公钥里的换行写成 `\n`（JSON 转义），不要直接断行。

不改这个文件也能构建：同名编译期环境变量优先级更高。

```bash
QZA_LICENSE_SERVER=http://127.0.0.1:8787 npm run tauri:build:windows
```

`scripts/build-local-windows.ps1` 做的就是这件事——注入本地回环地址，构建后断言产物里确实含有该地址，用来跑本地联调。四项全部落到占位值时 `CONFIG_IS_PLACEHOLDER` 为真：构建照常成功，但客户端会明确提示「本构建未配置授权服务器」，而不是让用户对着笼统的网络错误猜原因。
