# 贡献指南

## 分支

- 从最新 `main` 创建短生命周期分支。
- 文档改动使用 `docs/<主题>`，功能使用 `feat/<主题>`，修复使用 `fix/<主题>`，CI 使用 `ci/<主题>`。
- 不直接推送 `main`；所有改动通过 Pull Request 审查。

## 提交

采用 Conventional Commits：`type(scope): summary`。常用类型为 `feat`、`fix`、`docs`、`refactor`、`test`、`ci` 与 `chore`。摘要使用祈使语气，长度不超过 72 个字符。

## 代码约定

### 前端

界面由一套统一的设计令牌驱动，改动前请先阅读 [docs/UI-REFACTOR-SPEC.md](docs/UI-REFACTOR-SPEC.md)。

- **颜色、间距、圆角、阴影一律取自 `src/styles/tokens.css`**,不得硬编码。确需例外时（例如二维码画布必须保持白底，否则无法扫描）必须在原处写明原因。
- **优先使用 `src/components/ui/` 下的基础组件**（`SectionCard`、`EmptyState`、`SkeletonBlock`、`StatTile`），不要为每个页面重复实现卡片、空状态或骨架。
- **页面样式写在各自的 `<style scoped>` 中。** 项目已经移除全局页面样式表，请不要再引入新的全局样式文件。
- **图标使用 `lucide-vue-next`**,具名导入，线宽 `1.8`。
- **每个数据区域都必须实现加载、空、错误三种状态。** 空状态需要解释“为什么没有数据”并给出下一步操作。
- **不得伪造数据或进度。** 后端没有提供总量时使用不定长指示，不要编造百分比；数据尚未加载时显示骨架，不要显示 0。
- 图片一律带上 `loading="lazy"`、`decoding="async"` 与 `referrerpolicy="no-referrer"`。

### 后端

- 登录凭证不得写入日志、SQLite、前端存储或明文文件；桌面端只允许通过操作系统凭据库持久化。
- 新增会写入数据或访问腾讯接口的命令时，需要在函数首行调用授权守卫（`require_archive_access` 或 `require_read_access`）。纯本地读取与用户清理自己数据的操作不受限制。
- 授权校验逻辑改动请同步更新 `src-tauri/license-core/` 的单元测试。**本地校验是体验层而非安全边界**,不要在面向用户的文案里把它描述成防护措施。
- 不要让用户已经归档到本地的数据依赖授权状态。

## 验证

修改 Vue/Tauri 前端后运行 `npm test` 和 `npm run build`（包含 `vue-tsc --noEmit`）。`npm test` 使用受控的原生接口响应检查登录会话、错误提示、资料库异步状态和全局任务状态，不会连接真实 QQ 账号或访问凭据存储。修改文档站后运行 `npm --prefix website run build`。涉及 Rust 时运行 `cargo fmt --check` 和 `cargo check`；改动授权校验逻辑时另需运行 `cargo test --manifest-path src-tauri/license-core/Cargo.toml`。

如果当前环境无法执行某项检查（缺少链接器、没有图形界面等），请在说明中明确写出，不要暗示已经验证过。

## Pull Request

- 一个 PR 只解决一个明确的问题。
- 标题遵循 Conventional Commits，并与最近的 `fix:`、`ci:` PR 形式一致。
- 描述说明动机、变更、验证命令、风险或迁移影响。
- 关联 Issue；用户可见变更应附截图或录屏。
- 合并前，所有必需检查必须通过，且不包含无关格式化或生成文件。
