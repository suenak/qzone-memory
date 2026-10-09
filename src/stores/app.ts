import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

/**
 * 主题模式。
 *
 * `system` 会跟随操作系统的深浅色设置，并在系统切换时实时响应——
 * 首次使用默认浅色；选择跟随系统后保留该偏好。
 */
export type ThemeMode = "light" | "dark" | "system";

/** 界面密度。紧凑模式压缩列表行高与卡片留白，供信息密集场景使用。 */
export type Density = "comfortable" | "compact";

const THEME_KEY = "qzone-archive-theme";
const DENSITY_KEY = "qzone-archive-density";
const SIDEBAR_KEY = "qzone-archive-sidebar-collapsed";

function readTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
}

function readDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_KEY) === "true";
}

export const useAppStore = defineStore("app", () => {
  const themeMode = ref<ThemeMode>(readTheme());
  const density = ref<Density>(readDensity());
  const sidebarCollapsed = ref(readSidebarCollapsed());

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const systemPrefersDark = ref(prefersDark.matches);

  /** 最终生效的深浅色，已把 `system` 解析为具体取值。 */
  const resolvedDark = computed(() =>
    themeMode.value === "system" ? systemPrefersDark.value : themeMode.value === "dark",
  );

  function applyTheme() {
    const root = document.documentElement;
    // `.app-dark` 同时是 PrimeVue 的 darkModeSelector，挂在 <html> 上可让
    // 设计 tokens 与组件库主题一并切换。
    root.classList.toggle("app-dark", resolvedDark.value);
    root.classList.toggle("density-compact", density.value === "compact");
    // 让原生控件（滚动条、表单、日期选择器）也跟随主题，避免出现刺眼的白块。
    root.style.colorScheme = resolvedDark.value ? "dark" : "light";
  }

  watch([resolvedDark, density], applyTheme, { immediate: true });

  // 系统主题变化时实时同步，仅在 system 模式下影响最终结果。
  prefersDark.addEventListener("change", (event) => {
    systemPrefersDark.value = event.matches;
  });

  function setTheme(mode: ThemeMode) {
    themeMode.value = mode;
    localStorage.setItem(THEME_KEY, mode);
  }

  function setDensity(value: Density) {
    density.value = value;
    localStorage.setItem(DENSITY_KEY, value);
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    localStorage.setItem(SIDEBAR_KEY, String(sidebarCollapsed.value));
  }

  return {
    themeMode,
    density,
    sidebarCollapsed,
    resolvedDark,
    setTheme,
    setDensity,
    toggleSidebar,
  };
});
