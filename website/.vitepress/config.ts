import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "拾忆",
  description: "把值得留存的 QQ 空间记忆，安静地保存在你的设备上。",
  base: "/qzone-memory/",
  outDir: "./dist",
  head: [
    // head 里的 href 不会被自动加上 base，这里要写全。
    ["link", { rel: "icon", type: "image/png", href: "/qzone-memory/favicon.png?v=shiyi-v2-20261012" }],
    ["link", { rel: "apple-touch-icon", href: "/qzone-memory/favicon.png?v=shiyi-v2-20261012" }],
  ],
  themeConfig: {
    // 内容页（安装/开发/首归档…）走 VitePress 内置主题，它只在给了 logo 时才画图标，
    // 否则导航里只有一行文字标题。首页是自绘的 tech-nav，两边都指向同一张图。
    logo: "/logo-mark.png",
    nav: [
      { text: "文档", link: "/intro/" },
      { text: "GitHub", link: "https://github.com/suenak/qzone-memory" },
    ],
    sidebar: [
      { text: "开始使用", items: [{ text: "概览", link: "/intro/" }, { text: "安装", link: "/install/" }, { text: "首次归档", link: "/first-archive/" }, { text: "数据与安全", link: "/data-and-safety/" }] },
      { text: "参与项目", items: [{ text: "开发", link: "/development/" }, { text: "发布流程", link: "/release-process/" }] },
    ],
    search: { provider: "local" },
  },
});
