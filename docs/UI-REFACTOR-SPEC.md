# 前端重构规范

本文件是 QQ-Zone-Restore-Archive 前端 UI 重构的唯一执行标准。
所有页面重构都必须遵守，目的是让 13 个页面看起来像同一个人设计的。

---

## 1. 绝对约束

以下行为**一律禁止**,违反即视为重构失败：

1. **不得改动 `<script setup>` 中的业务逻辑**——Tauri 命令名、参数、返回值处理、
   状态字段、事件监听、定时器、生命周期钩子必须原样保留。
   允许的仅是为纯 UI 目的新增的 `ref` / `computed`（如展开状态、筛选状态）。
2. **不得删除任何功能**。原有按钮、筛选器、导出、删除、重试等入口必须全部保留，
   只是换一种视觉呈现。
3. **不得伪造数据**。加载中就用骨架屏，没有数据就显示空状态，
   绝对不允许用随机数字、假进度条或占位文本来撑版面。
4. **不得修改 Tauri 命令调用**。`invoke("xxx")` 与 `src/utils/qzone.ts` 里的封装
   全部保持不动。
5. **不得引入新的第三方依赖**。图标用已安装的 `lucide-vue-next`,
   复杂组件继续用 PrimeVue，基础容器用 `src/components/ui/` 下已有组件。
6. **不得在界面、日志或 localStorage 中出现 QQ Cookie 或临时的 `pwd2sig` 签名。**
7. **不得硬编码颜色、圆角、间距**。一律使用 `src/styles/tokens.css` 里的 CSS 变量。

## 2. 设计语言

**定位**：Modern Desktop App / Digital Memories / Minimalism / Premium。
要像 Linear 一样克制精确，像 Apple Photos 一样让内容成为主角，
像 Notion 一样层级清晰。**不要**做成廉价科技风——禁止大面积渐变、
禁止玻璃拟态、禁止发光边框。

### 色彩

| 用途 | 变量 |
|---|---|
| 页面底色 | `--color-canvas` |
| 卡片/面板 | `--color-surface` |
| 次级背景 | `--color-surface-sunken` |
| 边框 | `--color-border`,强调用 `--color-border-strong` |
| 主文字 | `--color-text` |
| 次要文字 | `--color-text-secondary` |
| 弱化文字 | `--color-text-tertiary` |
| 品牌/主操作 | `--color-accent`,`--color-accent-soft` 作浅底 |
| **回忆暖色** | `--color-warm`,`--color-warm-soft` |
| 语义色 | `--color-success` / `--color-warning` / `--color-danger` 及各自 `-soft` |

**暖色的使用纪律**：只用于时间轴、年份标记、"往年今日"这类确实承载怀旧语义的地方。
不要把它们当成第二个主色到处撒。

### 间距 / 圆角 / 阴影

只用 `--space-1`(4px) 到 `--space-16`(64px) 这一套 4px 基数的变量。
圆角用 `--radius-sm|md|lg|xl|full`。阴影用 `--shadow-xs|sm|md|lg`——
默认用 `xs`,悬浮或浮层才升级。**不要自己写 box-shadow 数值。**

### 字号

`--text-2xs`(11) `--text-xs`(12) `--text-sm`(13) `--text-base`(14)
`--text-md`(15) `--text-lg`(17) `--text-xl`(20) `--text-2xl`(24) `--text-3xl`(30)

正文默认 `--text-sm` 或 `--text-base`,页面主标题用 `--text-lg`,
统计数字用 `--text-2xl` 并加 `font-variant-numeric: tabular-nums`。

### 动效

过渡一律 `var(--duration-fast|base|slow)` + `var(--ease-out)`。
时长 150–300ms,不要更长。`prefers-reduced-motion` 已在 base.css 全局处理，无需重复。

## 3. 布局约定

- 应用外壳（侧边栏、顶栏、内容滚动）已由 `AppShell.vue` 提供，
  **页面组件不要再自己加外层 padding 或标题栏**。
- 页面根元素直接是内容容器，用 `display: flex; flex-direction: column; gap: var(--space-5)`
  组织纵向节奏。
- 页面级标题由 AppShell 的顶栏负责，页面内不要再重复一个 h1。
- 卡片一律用 `<SectionCard>` 包裹，不要自己写 `background + border + radius`。

## 4. 可用组件

来自 `src/components/ui/`：

| 组件 | 用途 | 关键 props |
|---|---|---|
| `SectionCard` | 所有成块内容的容器 | `title` `description` `flush`（表格/列表用）+ `#actions` `#footer` 插槽 |
| `EmptyState` | 空状态 | `icon`(lucide 组件) `title` `description` `tone`(neutral/warm/danger) `compact` |
| `SkeletonBlock` | 加载骨架 | `width` `height` `circle` `lines` |
| `StatTile` | 统计数字 | `label` `value` `hint` `icon` `tone`(accent/warm/success/neutral) `loading` |
| `ToastHost` | 提示（已在 App.vue 挂载） | 通过 `useToast()` 调用 |

提示用法：

```ts
import { useToast } from "../composables/useToast";
const toast = useToast();
toast.success("已导出到所选位置");
toast.error(String(reason));
```

**错误文案要翻译成人话。** 后端返回的 Rust 错误串（如 `准备联系人查询失败：...`）
不要原样甩给用户，用 `EmptyState` 或 toast 给出「发生了什么 + 能做什么」。

## 5. 图表标

统一用 `lucide-vue-next`,按需具名导入：

```ts
import { Images, Trash2, RefreshCw } from "lucide-vue-next";
```

```vue
<Images :size="18" :stroke-width="1.8" />
```

线宽统一 `1.8`,尺寸：导航/按钮 16–18、卡片图标 18–20、空状态 22–26、统计图标 18。
**不要用 PrimeIcons 的 `pi pi-*` 类名写新代码**（旧代码可暂时保留）。

常用映射：
概览 `LayoutDashboard`、说说 `MessageSquareQuote`、媒体 `Camera`、
相册 `Images`、视频 `Film`、留言 `Mail`、收藏 `Bookmark`、联系人 `Users`、
任务 `RefreshCw`、回收站 `Trash2`、设置 `Settings`、搜索 `Search`、
时间 `Calendar`、点赞 `Heart`、评论 `MessageCircle`、展开 `ChevronDown`、
导出 `Download`、删除 `Trash2`、关闭 `X`、成功 `CircleCheck`、警告 `CircleAlert`。

## 6. 四种状态缺一不可

每个数据区域都必须实现：

- **Loading** —— `SkeletonBlock`,形状要接近真实内容的轮廓（列表就画几行，
  卡片网格就画几个方块）。**不要用转圈 spinner 占满整页。**
- **Empty** —— `EmptyState`,必须解释**为什么**为空，并给出下一步。
  例：「还没有归档内容 / 先在归档任务里点一次开始归档，历史说说会出现在这里」
- **Error** —— 说明发生了什么 + 一个可执行的恢复操作（重试按钮、去登录等）。
- **Success** —— 克制，一般不需要额外提示；只有用户看不见结果的异步操作才用 toast。

长任务必须有可见状态，并且离开页面再回来时状态不能丢——共享状态请用
`src/stores/archive.ts`（已提供 `progress` / `running` 与轮询启停）。

## 7. 性能要求

- 大列表**必须分页或虚拟化**。项目里 `list_archived_feeds` 本身就支持
  `limit` / `offset`,请沿用增量加载（滚动到底自动加载下一页）而不是一次性拉全量。
- 图片一律 `loading="lazy"` `decoding="async"`,并提供加载失败占位。
- 头像等小图加 `referrerpolicy="no-referrer"`（QQ 头像域名对 referer 敏感）。
- 不要为每条记录创建重型 watcher 或定时器。

## 8. 响应式

必须在 1440×900、1280×800、1024×768、800×600 下都可用：
内容可滚动、按钮可点击、弹窗不超出屏幕。

- `≤1080px`：收紧间距，次要列可隐藏。
- `≤860px`：侧边栏已被 AppShell 换成底部导航，页面自身改为单列。
- 表格在窄屏改为卡片堆叠，不要出现横向滚动条。
- 网格用 `repeat(auto-fill, minmax(Npx, 1fr))` 而非固定列数。

## 9. 文案

中文，自然、简洁、不啰嗦。避免：

- 技术黑话（"实例化"、"句柄"、"序列化"）
- 感叹号堆砌
- 直接暴露后端错误堆栈

好的例子：「还没有归档任何说说 / 开始一次归档，你发布过的历史动态会按时间出现在这里」
坏的例子：「暂无数据！」「Error: 准备联系人查询失败」

## 10. 交付检查

改完一个页面后自查：

1. `npm run build` 通过（含 `vue-tsc --noEmit`）。
2. 浅色与深色下都看过了吗？深色下有没有白底黑字的硬伤？
3. 加载 / 空 / 错误三种状态都存在吗？
4. 原有每个按钮、筛选器、菜单都还在吗？
5. 有没有留下硬编码的颜色、px 数值或 PrimeIcons 类名？
6. 窄屏（800px 宽）下有没有溢出或错位？
