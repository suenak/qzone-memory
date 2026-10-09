---
title: 开发
---

# 开发

## 前置条件

- Node.js 20+
- Rust 1.77+
- Windows 开发环境需 WebView2
- Android 开发还需要 Android Studio、SDK 与 NDK

```bash
npm ci
npm run tauri dev
```

## 验证

```bash
npm run build                # 前端类型检查 + 构建
cargo fmt --check            # Rust 格式检查
cargo check                  # Rust 类型检查
cargo test --manifest-path src-tauri/license-core/Cargo.toml   # 授权凭证校验逻辑
```

界面改动请先阅读 [docs/UI-REFACTOR-SPEC.md](https://github.com/suenak/qzone-memory/blob/main/docs/UI-REFACTOR-SPEC.md)：所有颜色、间距与圆角必须取自 `src/styles/tokens.css` 的设计令牌，通用容器使用 `src/components/ui/` 下的基础组件，每个数据区域都要实现加载、空与错误状态。

## 文档站

文档站是独立工作区，不会参与 Tauri 打包：

```bash
cd website
npm ci
npm run dev
```

文档内容使用 Markdown，放在 `website/` 下的目录索引页。提交前执行 `npm run build`。

## 提交与 Pull Request

遵循仓库的 [贡献指南](https://github.com/suenak/qzone-memory/blob/main/CONTRIBUTING.md)。每个 PR 聚焦一个主题，使用 Conventional Commits 标题，并说明验证方式和风险。
