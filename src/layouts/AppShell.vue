<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Component } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import { platform } from "../utils/platform";
import {
  Bookmark,
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  Film,
  Globe,
  Images,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquareQuote,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  User,
  Users,
} from "lucide-vue-next";
import Drawer from "primevue/drawer";
import Popover from "primevue/popover";
import LoginDialog from "../components/LoginDialog.vue";
import { useAppStore, type ThemeMode } from "../stores/app";
import { useArchiveStore } from "../stores/archive";
import { useAuthStore } from "../stores/auth";
import { useToast } from "../composables/useToast";
import { describeError } from "../utils/uiError";

defineProps<{ pageTitle: string }>();

const appStore = useAppStore();
const archiveStore = useArchiveStore();
const authStore = useAuthStore();
const toast = useToast();
const router = useRouter();
const route = useRoute();

const accountPopover = ref<InstanceType<typeof Popover>>();
const themePopover = ref<InstanceType<typeof Popover>>();
const moreVisible = ref(false);
const logoutLoading = ref(false);
const searchInput = ref("");
const mobileSearchVisible = ref(false);
const searchElement = ref<HTMLInputElement>();

const { sidebarCollapsed, themeMode } = storeToRefs(appStore);
const { loggedIn, user } = storeToRefs(authStore);

interface NavItem {
  label: string;
  icon: Component;
  to: string;
  /** 一句话说明，同时用于折叠态的悬停提示与移动端「更多」列表。 */
  hint: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * 导航结构按「数据来源」而不是「技术模块」分组：
 * 说说与媒体来自互动记录，相册/视频/留言/收藏来自空间资料库，
 * 任务与回收站是工具。这样用户更容易建立位置感。
 */
const navigationGroups: NavGroup[] = [
  {
    label: "回忆",
    items: [
      { label: "首页", icon: LayoutDashboard, to: "/", hint: "备份规模与互动排行" },
      { label: "说说", icon: MessageSquareQuote, to: "/archives", hint: "按时间翻阅历史动态" },
      { label: "说说照片与视频", icon: Camera, to: "/media", hint: "动态中的照片与视频" },
    ],
  },
  {
    label: "空间资料",
    items: [
      { label: "相册", icon: Images, to: "/albums", hint: "空间相册与照片" },
      { label: "视频", icon: Film, to: "/videos", hint: "空间视频资料" },
      { label: "留言板", icon: Mail, to: "/guestbook", hint: "他人留下的留言" },
      { label: "收藏", icon: Bookmark, to: "/favorites", hint: "空间收藏内容" },
      { label: "联系人", icon: Users, to: "/contacts", hint: "与你互动过的人" },
    ],
  },
  {
    label: "管理与设置",
    items: [
      { label: "备份任务", icon: RefreshCw, to: "/tasks", hint: "进度、停止与继续备份" },
      { label: "相册回收站", icon: Trash2, to: "/recycle-bin", hint: "恢复误删的相册照片" },
      { label: "设置", icon: SettingsIcon, to: "/settings", hint: "外观、账号与数据管理" },
    ],
  },
];

const allNavigation = navigationGroups.flatMap((group) => group.items);

/**
 * 移动端底部只放最常用的四项，其余进「更多」。
 *
 * 用路径定位而不是数组下标：原先的 allNavigation[0]/[1]/[3]/[8] 与导航分组
 * 强耦合，只要在分组里插入一项，底栏内容就会静默换成另一组页面。
 */
const MOBILE_DESTINATIONS = ["/", "/archives", "/albums", "/tasks"];
const mobileNavigation = MOBILE_DESTINATIONS.map((path) =>
  allNavigation.find((item) => item.to === path),
).filter((item): item is NavItem => Boolean(item));
const mobileMoreNavigation = allNavigation.filter((item) => !mobileNavigation.includes(item));

const moreActive = computed(() =>
  mobileMoreNavigation.some(
    (item) => route.path === item.to || route.path.startsWith(`${item.to}/`),
  ),
);

const pageSubtitle = computed(() => {
  const current = allNavigation.find((item) =>
    item.to === "/" ? route.path === "/" : route.path.startsWith(item.to),
  );
  return current?.hint ?? "";
});

const showQzoneButton = computed(() => {
  const currentPlatform = platform();
  return currentPlatform !== "android" && currentPlatform !== "ios";
});

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: Component }[] = [
  { mode: "light", label: "浅色", icon: Sun },
  { mode: "dark", label: "深色", icon: Moon },
  { mode: "system", label: "跟随系统", icon: Monitor },
];

const themeIcon = computed(() => {
  const found = THEME_OPTIONS.find((option) => option.mode === themeMode.value);
  return found?.icon ?? Monitor;
});

const archiveRunning = computed(() => archiveStore.running);
const archiveSummary = computed(() => {
  const progress = archiveStore.progress;
  if (!progress) return "";
  if (progress.status === "running") return `已保存 ${progress.saved} 条`;
  if (progress.status === "completed") return "上次备份已完成";
  if (progress.status === "limited") return "请求过于频繁，稍后可继续";
  if (progress.status === "error") return "上次备份未完成";
  return "备份已停止";
});

function qzoneUrl() {
  const uin = user.value?.uin;
  if (platform() === "android") {
    return uin ? `https://m.qzone.qq.com/${uin}` : "https://m.qzone.qq.com";
  }
  return uin ? `https://user.qzone.qq.com/${uin}` : "https://user.qzone.qq.com";
}

async function openQzoneWindow() {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("qzone-browser");
    if (existing) {
      await existing.setFocus();
      return;
    }
    await new WebviewWindow("qzone-browser", {
      url: qzoneUrl(),
      title: "QQ 空间",
      width: 1000,
      height: 720,
      minWidth: 480,
      minHeight: 500,
      center: true,
    });
  } catch {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(qzoneUrl());
  }
}

function handleAccountClick(event: MouseEvent) {
  if (loggedIn.value) accountPopover.value?.toggle(event);
  else authStore.openLogin();
}

function handleThemeClick(event: MouseEvent) {
  themePopover.value?.toggle(event);
}

function selectTheme(mode: ThemeMode) {
  appStore.setTheme(mode);
  themePopover.value?.hide();
}

async function logout() {
  if (logoutLoading.value || archiveStore.running) return;
  logoutLoading.value = true;
  try {
    accountPopover.value?.hide();
    await authStore.logout();
    await router.push("/");
    toast.success("已退出 QQ 登录。");
  } catch (reason) {
    toast.error(describeError(reason, "退出登录失败，请重试。"));
  } finally {
    logoutLoading.value = false;
  }
}
watch(mobileSearchVisible, async (open) => { if (open) { await nextTick(); searchElement.value?.focus(); } });

/** 全局搜索入口：把关键词交给说说页，由它负责真正的检索。 */
function submitSearch() {
  const query = searchInput.value.trim();
  if (query === "") return;
  void router.push({ path: "/archives", query: { q: query } });
  searchInput.value = "";
  mobileSearchVisible.value = false;
}

function handleSearchShortcut(event: KeyboardEvent) {
  if (document.querySelector('[role="dialog"]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    mobileSearchVisible.value = true;
    requestAnimationFrame(() => searchElement.value?.focus());
  }
  if (event.key === "Escape") mobileSearchVisible.value = false;
}

onMounted(() => document.addEventListener("keydown", handleSearchShortcut));
onBeforeUnmount(() => document.removeEventListener("keydown", handleSearchShortcut));

onMounted(() => {
  // 侧边栏需要全局可见的备份状态，因此轮询在这里启停，TasksView 复用同一份数据。
  archiveStore.startPolling();
});

onBeforeUnmount(() => {
  archiveStore.stopPolling();
});
</script>

<template>
  <div class="app-shell">
    <!-- ------------------------------------------------------ 桌面侧边栏 -->
    <aside class="sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <div class="sidebar__brand">
        <span class="brand-mark" aria-hidden="true"><BookOpen :size="20" :stroke-width="1.8" /></span>
        <span class="brand-text">
          <strong>拾忆</strong>
          <small>QQ 空间本地备份</small>
        </span>
      </div>

      <nav class="sidebar__nav" aria-label="主要导航">
        <section v-for="group in navigationGroups" :key="group.label" class="nav-group">
          <p class="nav-group__label">{{ group.label }}</p>
          <RouterLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="nav-item"
            :title="sidebarCollapsed ? item.label : undefined"
          >
            <component :is="item.icon" class="nav-item__icon" :size="18" :stroke-width="1.8" />
            <span class="nav-item__label">{{ item.label }}</span>
          </RouterLink>
        </section>
      </nav>

      <div class="sidebar__foot">
        <button class="sidebar-profile" type="button" :aria-label="loggedIn ? '打开账号菜单' : '登录 QQ 空间'" @click="handleAccountClick">
          <span class="account-chip__avatar"><img v-if="user?.avatarImage" :src="user.avatarImage" alt="" decoding="async" /><User v-else :size="17" :stroke-width="1.8" /></span>
          <span class="sidebar-profile__copy"><strong>{{ user?.nickname || '尚未登录' }}</strong><small>{{ loggedIn ? `QQ ${user?.uin}` : '登录 QQ 空间后开始备份' }}</small></span>
        </button>
        <RouterLink
          v-if="archiveStore.progress"
          to="/tasks"
          class="sync-chip"
          :class="{ 'is-running': archiveRunning }"
          :title="sidebarCollapsed ? archiveSummary : undefined"
        >
          <span class="sync-chip__dot" />
          <span class="sync-chip__text">
            <strong>{{ archiveRunning ? "正在备份" : "备份状态" }}</strong>
            <small>{{ archiveSummary }}</small>
          </span>
        </RouterLink>

        <button
          class="sidebar__collapse"
          type="button"
          :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="appStore.toggleSidebar"
        >
          <component
            :is="sidebarCollapsed ? PanelLeftOpen : PanelLeftClose"
            :size="16"
            :stroke-width="1.8"
          />
          <span class="sidebar__collapse-text">收起侧边栏</span>
        </button>
      </div>
    </aside>

    <!-- -------------------------------------------------------- 主工作区 -->
    <div class="workspace">
      <header class="topbar" :class="{ 'has-search': mobileSearchVisible }">
        <div class="topbar__heading">
          <h1 class="topbar__title">{{ pageTitle }}</h1>
          <p v-if="pageSubtitle" class="topbar__subtitle">{{ pageSubtitle }}</p>
        </div>

        <label class="topbar__search" :class="{ 'is-open': mobileSearchVisible }">
          <Search :size="15" :stroke-width="1.8" aria-hidden="true" />
          <input
            v-model="searchInput"
            ref="searchElement"
            type="search"
            placeholder="搜索已备份的说说"
            aria-label="搜索已备份的说说"
            @keydown.enter.prevent="submitSearch"
          />
          <kbd>Ctrl K</kbd>
        </label>

        <div class="topbar__actions">
          <button class="icon-button mobile-search-toggle" type="button" aria-label="搜索说说" :aria-expanded="mobileSearchVisible" @click="mobileSearchVisible = !mobileSearchVisible"><Search :size="18" :stroke-width="1.8" /></button>
          <RouterLink to="/tasks" class="toolbar-sync" :class="{ 'is-running': archiveRunning }" :aria-label="archiveRunning ? archiveSummary : '打开备份任务'"><RefreshCw :size="15" :stroke-width="1.8" /><span>{{ archiveRunning ? '正在备份' : '备份任务' }}</span></RouterLink>
          <button
            class="icon-button"
            type="button"
            :aria-label="`主题：${THEME_OPTIONS.find((o) => o.mode === themeMode)?.label}`"
            @click="handleThemeClick"
          >
            <component :is="themeIcon" :size="17" :stroke-width="1.8" />
          </button>

          <button
            class="account-chip"
            type="button"
            :aria-label="loggedIn ? '打开账号菜单' : '登录 QQ 空间'"
            @click="handleAccountClick"
          >
            <span class="account-chip__avatar">
              <img v-if="user?.avatarImage" :src="user.avatarImage" alt="" />
              <User v-else :size="16" :stroke-width="1.8" />
            </span>
            <span class="account-chip__copy">
              <strong>{{ user?.nickname ?? "尚未登录" }}</strong>
              <small>{{ user ? `QQ ${user.uin}` : "点击登录" }}</small>
            </span>
          </button>
        </div>
      </header>

      <main id="main-content" class="content" tabindex="-1">
        <div class="content__inner">
          <slot />
        </div>
      </main>
    </div>

    <!-- ------------------------------------------------------ 移动端导航 -->
    <nav class="mobile-nav" aria-label="移动端导航">
      <RouterLink v-for="item in mobileNavigation" :key="item.to" :to="item.to" class="mobile-nav__item">
        <component :is="item.icon" :size="19" :stroke-width="1.8" />
        <span>{{ item.label }}</span>
      </RouterLink>
      <button
        class="mobile-nav__item"
        :class="{ 'is-active': moreActive }"
        type="button"
        aria-label="打开更多页面"
        @click="moreVisible = true"
      >
        <MoreHorizontal :size="19" :stroke-width="1.8" />
        <span>更多</span>
      </button>
    </nav>

    <!-- ------------------------------------------------------------ 浮层 -->
    <Popover ref="themePopover" class="theme-popover">
      <div class="popover-menu">
        <button
          v-for="option in THEME_OPTIONS"
          :key="option.mode"
          type="button"
          class="popover-menu__item"
          :class="{ 'is-selected': themeMode === option.mode }"
          @click="selectTheme(option.mode)"
        >
          <component :is="option.icon" :size="16" :stroke-width="1.8" />
          <span>{{ option.label }}</span>
          <Check v-if="themeMode === option.mode" :size="14" :stroke-width="2.2" />
        </button>
      </div>
    </Popover>

    <Popover ref="accountPopover" class="account-popover">
      <div class="account-popover__profile">
        <span class="account-popover__avatar">
          <img v-if="user?.avatarImage" :src="user.avatarImage" alt="" />
          <User v-else :size="18" :stroke-width="1.8" />
        </span>
        <div>
          <strong>{{ user?.nickname }}</strong>
          <span>QQ {{ user?.uin }}</span>
        </div>
      </div>
      <div class="popover-menu">
        <button v-if="showQzoneButton" type="button" class="popover-menu__item" @click="openQzoneWindow(); accountPopover?.hide()">
          <Globe :size="16" :stroke-width="1.8" />
          <span>打开 QQ 空间</span>
        </button>
        <button type="button" class="popover-menu__item is-danger" :disabled="logoutLoading || archiveStore.running" @click="logout">
          <LogOut :size="16" :stroke-width="1.8" />
          <span>{{ logoutLoading ? "正在退出…" : "退出登录" }}</span>
        </button>
        <small v-if="archiveStore.running">请先停止备份，再退出登录。</small>
      </div>
    </Popover>

    <Drawer v-model:visible="moreVisible" position="bottom" header="更多页面" aria-label="更多页面" class="mobile-more-drawer">
      <nav class="mobile-more" aria-label="更多页面">
        <RouterLink
          v-for="item in mobileMoreNavigation"
          :key="item.to"
          :to="item.to"
          class="mobile-more__item"
          :aria-label="item.label"
          @click="moreVisible = false"
        >
          <span class="mobile-more__icon"><component :is="item.icon" :size="17" :stroke-width="1.8" /></span>
          <span class="mobile-more__copy">
            <strong>{{ item.label }}</strong>
            <small>{{ item.hint }}</small>
          </span>
          <ChevronRight :size="15" :stroke-width="1.8" />
        </RouterLink>
      </nav>
    </Drawer>

    <LoginDialog />
  </div>
</template>

<style scoped>
.app-shell { display:flex; width:100%; height:100%; background:var(--color-canvas); }
.sidebar { display:flex; flex-direction:column; flex-shrink:0; width:var(--layout-sidebar-width); height:100%; background:var(--color-sidebar); border-right:var(--line-width) solid var(--color-border); transition:width var(--duration-base) var(--ease-out); }
.sidebar.is-collapsed { width:var(--layout-sidebar-collapsed); }
.sidebar__brand { display:flex; align-items:center; gap:var(--space-3); min-height:var(--layout-topbar-height); padding:var(--space-4); }
.brand-mark { display:grid; place-items:center; flex-shrink:0; width:var(--control-height); height:var(--control-height); border-radius:var(--radius-lg); background:var(--color-accent); color:var(--color-on-accent); }
.brand-text { display:flex; flex-direction:column; min-width:0; gap:var(--space-1); }
.brand-text strong { font-size:var(--text-md); letter-spacing:.025em; }
.brand-text small { font-size:var(--text-2xs); color:var(--color-text-secondary); white-space:nowrap; }
.sidebar__nav { flex:1; min-height:0; overflow-y:auto; padding:var(--space-4) var(--space-3); }
.nav-group + .nav-group { margin-top:var(--space-6); }
.nav-group__label { padding:0 var(--space-3); margin-bottom:var(--space-2); font-size:var(--text-2xs); color:var(--color-text-tertiary); font-weight:var(--weight-medium); }
.nav-item { display:flex; align-items:center; gap:var(--space-3); min-height:var(--control-height); padding:var(--space-2) var(--space-3); margin-bottom:var(--space-1); border:var(--line-width) solid transparent; border-radius:var(--radius-md); color:var(--color-text-secondary); font-size:var(--text-sm); transition:background-color var(--duration-fast) var(--ease-out),color var(--duration-fast) var(--ease-out); }
.nav-item:hover { background:var(--color-surface); color:var(--color-text); text-decoration:none; }
.nav-item.router-link-active { color:var(--color-accent); background:var(--color-surface); border-color:var(--color-border); box-shadow:var(--shadow-xs); font-weight:var(--weight-semibold); }
.nav-item__icon { flex-shrink:0; }
.nav-item__label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sidebar__foot { padding:var(--space-3); border-top:var(--line-width) solid var(--color-border); }
.sidebar-profile { display:flex; align-items:center; gap:var(--space-3); width:100%; padding:var(--space-2); margin-bottom:var(--space-3); border:0; background:transparent; border-radius:var(--radius-md); text-align:left; }
.sidebar-profile:hover { background:var(--color-surface); }
.sidebar-profile__copy { display:flex; flex-direction:column; min-width:0; }
.sidebar-profile__copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--text-xs); }
.sidebar-profile__copy small { color:var(--color-text-secondary); font-size:var(--text-2xs); }
.sync-chip { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-3); margin-bottom:var(--space-2); border-radius:var(--radius-md); background:var(--color-surface); }
.sync-chip:hover { text-decoration:none; }
.sync-chip__dot { width:var(--space-2); height:var(--space-2); flex-shrink:0; border-radius:var(--radius-full); background:var(--color-text-tertiary); }
.sync-chip.is-running .sync-chip__dot { background:var(--color-accent); }
.sync-chip__text { display:flex; flex-direction:column; min-width:0; }
.sync-chip__text strong { color:var(--color-text); font-size:var(--text-xs); }
.sync-chip__text small { color:var(--color-text-secondary); font-size:var(--text-2xs); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sidebar__collapse { display:flex; align-items:center; gap:var(--space-2); width:100%; min-height:var(--control-compact); padding:var(--space-2); border:0; border-radius:var(--radius-md); background:transparent; color:var(--color-text-secondary); font-size:var(--text-xs); }
.sidebar__collapse:hover { background:var(--color-surface); }
.sidebar.is-collapsed .brand-text,.sidebar.is-collapsed .nav-item__label,.sidebar.is-collapsed .sidebar-profile__copy,.sidebar.is-collapsed .sync-chip__text,.sidebar.is-collapsed .sidebar__collapse-text { display:none; }
.sidebar.is-collapsed .nav-group__label { font-size:0; border-top:var(--line-width) solid var(--color-border); margin:var(--space-3) var(--space-2); padding:0; }
.sidebar.is-collapsed .nav-item,.sidebar.is-collapsed .sidebar-profile,.sidebar.is-collapsed .sidebar__collapse,.sidebar.is-collapsed .sync-chip,.sidebar.is-collapsed .sidebar__brand { justify-content:center; padding-inline:0; }
.workspace { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; height:100%; }
.topbar { display:flex; align-items:center; gap:var(--space-4); flex-shrink:0; min-height:var(--layout-topbar-height); padding:var(--space-3) var(--space-8); border-bottom:var(--line-width) solid var(--color-border); background:var(--color-surface); }
.topbar__heading { min-width:0; }
.topbar__title { font-size:var(--text-base); font-weight:var(--weight-semibold); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.topbar__subtitle { margin-top:var(--space-1); font-size:var(--text-2xs); color:var(--color-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.topbar__search { display:flex; align-items:center; gap:var(--space-2); flex:1; max-width:var(--layout-header-search); margin-left:auto; min-height:var(--control-height); padding:0 var(--space-3); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); background:var(--color-canvas); color:var(--color-text-secondary); }
.topbar__search:focus-within { border-color:var(--color-accent); box-shadow:var(--shadow-focus); }
.topbar__search input { flex:1; min-width:0; width:100%; border:0; outline:none; background:transparent; color:var(--color-text); font-size:var(--text-sm); }
.topbar__search input::placeholder { color:var(--color-text-tertiary); }
.topbar__search kbd { flex-shrink:0; font-family:var(--font-mono); font-size:var(--text-2xs); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-xs); padding:0 var(--space-1); }
.topbar__actions { display:flex; align-items:center; gap:var(--space-2); flex-shrink:0; }
.icon-button { display:grid; place-items:center; width:var(--control-height); height:var(--control-height); border:0; border-radius:var(--radius-md); background:transparent; color:var(--color-text-secondary); }
.icon-button:hover { background:var(--color-surface-sunken); }
.toolbar-sync { display:flex; align-items:center; gap:var(--space-2); min-height:var(--control-height); padding:0 var(--space-3); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); font-size:var(--text-xs); color:var(--color-text-secondary); }
.toolbar-sync:hover { background:var(--color-surface-sunken); text-decoration:none; }
.toolbar-sync.is-running { color:var(--color-accent); background:var(--color-accent-soft); }
.account-chip { display:flex; align-items:center; gap:var(--space-2); max-width:var(--layout-gallery-cell); min-height:var(--control-height); padding:var(--space-1) var(--space-2); border:var(--line-width) solid transparent; border-radius:var(--radius-md); background:transparent; }
.account-chip:hover { background:var(--color-surface-sunken); }
.account-chip__avatar,.account-popover__avatar { display:grid; place-items:center; width:var(--space-8); height:var(--space-8); flex-shrink:0; border-radius:var(--radius-full); background:var(--color-accent-soft); color:var(--color-accent); overflow:hidden; }
.account-chip__avatar img,.account-popover__avatar img { width:100%; height:100%; object-fit:cover; }
.account-chip__copy { display:flex; flex-direction:column; min-width:0; text-align:left; }
.account-chip__copy strong { font-size:var(--text-xs); font-weight:var(--weight-medium); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.account-chip__copy small { font-size:var(--text-2xs); color:var(--color-text-secondary); }
.content { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; scroll-padding-top:var(--space-6); }
.content__inner { width:100%; max-width:var(--layout-content-max); margin:0 auto; padding:var(--space-8) var(--space-8) var(--space-12); }
.popover-menu { display:flex; flex-direction:column; min-width:var(--layout-gallery-cell); padding:var(--space-1); }
.popover-menu__item { display:flex; align-items:center; gap:var(--space-3); width:100%; min-height:var(--control-height); padding:var(--space-2) var(--space-3); border:0; border-radius:var(--radius-sm); background:transparent; color:var(--color-text-secondary); font-size:var(--text-sm); text-align:left; }
.popover-menu__item span { flex:1; }
.popover-menu__item:hover:not(:disabled) { background:var(--color-surface-sunken); }
.popover-menu__item.is-selected { color:var(--color-accent); }
.popover-menu__item.is-danger { color:var(--color-danger); }
.popover-menu__item:disabled { opacity:.5; cursor:not-allowed; }
.account-popover__profile { display:flex; align-items:center; gap:var(--space-3); padding:var(--space-3); margin-bottom:var(--space-1); border-bottom:var(--line-width) solid var(--color-border); }
.account-popover__profile strong { display:block; font-size:var(--text-sm); }
.account-popover__profile span { font-size:var(--text-xs); color:var(--color-text-secondary); }
.mobile-nav,.mobile-search-toggle { display:none; }
.mobile-more { display:flex; flex-direction:column; gap:var(--space-1); }
.mobile-more__item { display:flex; align-items:center; gap:var(--space-3); min-height:var(--touch-target); padding:var(--space-3); border-radius:var(--radius-md); color:var(--color-text); }
.mobile-more__item:hover { background:var(--color-surface-sunken); text-decoration:none; }
.mobile-more__icon { display:grid; place-items:center; width:var(--control-height); height:var(--control-height); border-radius:var(--radius-md); background:var(--color-accent-soft); color:var(--color-accent); }
.mobile-more__copy { flex:1; min-width:0; }
.mobile-more__copy strong { display:block; font-size:var(--text-sm); }
.mobile-more__copy small { font-size:var(--text-xs); color:var(--color-text-secondary); }
@media (max-width:1080px) { .topbar,.content__inner { padding-inline:var(--space-5); } .account-chip__copy,.topbar__search kbd,.toolbar-sync span { display:none; } .topbar__search { max-width:var(--layout-sidebar-width); } }
@media (max-width:860px) {
 .app-shell { flex-direction:column; } .sidebar { display:none; } .workspace { height:auto; }
 .topbar { flex-wrap:wrap; padding:var(--space-3) var(--space-4); gap:var(--space-2); } .topbar__heading { flex:1; } .topbar__subtitle { max-width:var(--layout-gallery-cell); }
 .topbar__search { display:none; } .topbar__search.is-open { display:flex; order:3; flex-basis:100%; max-width:none; margin:0; }
 .mobile-search-toggle { display:grid; } .toolbar-sync { display:none; }
 .content__inner { padding:var(--space-5) var(--space-4) var(--space-8); }
 .mobile-nav { display:flex; align-items:stretch; flex-shrink:0; min-height:calc(var(--layout-mobile-nav-height) + env(safe-area-inset-bottom)); padding-bottom:env(safe-area-inset-bottom); border-top:var(--line-width) solid var(--color-border); background:var(--color-surface); }
 .mobile-nav__item { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--space-1); min-height:var(--touch-target); flex:1; border:0; background:transparent; color:var(--color-text-secondary); font-size:var(--text-2xs); }
 .mobile-nav__item.router-link-active,.mobile-nav__item.is-active { color:var(--color-accent); background:var(--color-accent-soft); }
 .mobile-nav__item:hover { text-decoration:none; } .icon-button,.account-chip { min-height:var(--touch-target); min-width:var(--touch-target); }
}
</style>
