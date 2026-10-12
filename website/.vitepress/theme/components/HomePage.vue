<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { withBase } from "vitepress";
import source from "../../../public/marketing-home.html?raw";
import { initializeMarketing } from "../../../public/marketing-ui.js";
import "../../../public/marketing.css";
import "../../../public/marketing-motion.css";
const root = ref<HTMLElement>();
const site = "https://qzone.teamxbw.top/";
const labels: Record<string, string> = {
  "windows-x86_64": "前往官网下载 Windows 版",
  "darwin-aarch64": "前往官网下载 Apple 芯片版",
  "darwin-x86_64": "前往官网下载 Intel 版",
  android: "前往官网下载 Android 版",
  ios: "前往官网下载 iOS 未签名包",
};
let html = source
  .replaceAll("__HOME__", withBase("/"))
  .replaceAll("__ASSETS__", withBase("/marketing-assets/"))
  .replaceAll("__PRIVACY__", site + "privacy")
  .replaceAll("__TERMS__", site + "terms")
  .replaceAll("__LICENSE__", site + "license")
  .replaceAll("__GUIDE__", withBase("/install/"));
html = html
  .replace(
    /data-platform="([^"]+)"\s+aria-disabled="true"\s+tabindex="-1"\s*>\s*正在获取安装包…/g,
    (_, platform: string) => {
      const os = platform.startsWith("darwin")
        ? "macos"
        : platform.startsWith("windows")
          ? "windows"
          : platform;
      return `href="${site}?platform=${os}#download">${labels[platform]}`;
    },
  )
  .replace("正在获取最新版本…", "安装包版本与官网同步")
  .replace(/<button\s+id="download-retry"[\s\S]*?<\/button>/, "");
let cleanup = () => {};
let query: MediaQueryList | undefined;
const applyTheme = () => {
  let mode = "system";
  try {
    mode = localStorage.getItem("qzone-site-theme") || "system";
  } catch {
    /* System theme remains available. */
  }
  if (!["light", "dark", "system"].includes(mode)) mode = "system";
  document.documentElement.classList.toggle(
    "dark",
    mode === "dark" || (mode === "system" && !!query?.matches),
  );
  root.value
    ?.querySelectorAll<HTMLElement>("[data-theme-set]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.themeSet === mode),
      ),
    );
};
const chooseTheme = (event: MouseEvent) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-theme-set]",
  );
  if (!button) return;
  try {
    localStorage.setItem(
      "qzone-site-theme",
      button.dataset.themeSet || "system",
    );
  } catch {
    /* Storage may be unavailable. */
  }
  applyTheme();
};
onMounted(() => {
  cleanup = initializeMarketing(root.value);
  query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", applyTheme);
  root.value?.addEventListener("click", chooseTheme);
  applyTheme();
});
onBeforeUnmount(() => {
  cleanup();
  query?.removeEventListener("change", applyTheme);
  root.value?.removeEventListener("click", chooseTheme);
});
</script>
<template><div ref="root" class="marketing-site" v-html="html" /></template>
