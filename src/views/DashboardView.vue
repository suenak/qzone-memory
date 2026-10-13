<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { fetch } from "@tauri-apps/plugin-http";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import {
  Archive,
  ChevronRight,
  Database,
  Download,
  Heart,
  Images,
  LogIn,
  MessageCircle,
  MessageSquareQuote,
  RefreshCw,
  Sparkles,
  User,
  Users,
} from "lucide-vue-next";
import Button from "primevue/button";
import QzoneText from "../components/QzoneText.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import StatTile from "../components/ui/StatTile.vue";
import ArchiveHeading from "../components/ui/ArchiveHeading.vue";
import { BookOpen } from "lucide-vue-next";
import { useArchiveStore } from "../stores/archive";
import { useAuthStore } from "../stores/auth";
import { getArchiveOverview, getArchiveProgress, getInteractionRanking, listArchivedFeeds, listArchiveYears, IDLE_ARCHIVE_PROGRESS, type ArchiveItem, type ArchiveOverview, type ArchiveProgress, type InteractionRank } from "../utils/qzone";

const router = useRouter();
const authStore = useAuthStore();
const archiveStore = useArchiveStore();
const { loggedIn, user } = storeToRefs(authStore);
const overview = ref<ArchiveOverview>({ dynamics: 0, pictures: 0, comments: 0, likes: 0, databaseBytes: 0 });
const progress = ref<ArchiveProgress>(IDLE_ARCHIVE_PROGRESS);
const recent = ref<ArchiveItem[]>([]);
const ranking = ref<InteractionRank[]>([]);
/** 备份覆盖的年份列表，用于推导回忆跨度。取不到时为空，界面退回时间锚点。 */
const archiveYears = ref<number[]>([]);
const loading = ref(false);
const dashboardError = ref("");
const avatarSources = reactive<Record<string, string>>({});
let refreshTimer: number | undefined;
/** 登出或重新加载都会让在途请求作废，否则轮询期间旧账号的概览与排行会写回界面。 */
let loadSequence = 0;
const storageText = computed(() => overview.value.databaseBytes < 1024 * 1024 ? `${(overview.value.databaseBytes / 1024).toFixed(1)} KB` : `${(overview.value.databaseBytes / 1024 / 1024).toFixed(1)} MB`);
const taskSeverity = computed(() => ({ completed: "success", partial: "warn", running: "info", error: "danger", cancelled: "warn", limited: "warn", idle: "secondary" }[progress.value.status]));
const taskText = computed(() => ({ completed: "已完成", partial: "未读取完整", running: "恢复中", error: "失败", cancelled: "已取消", limited: "稍后继续", idle: "未开始" }[progress.value.status]));
const formatTime = (seconds: number) => seconds ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(seconds * 1000)) : "时间未知";
// 地址必须稳定：loadAvatar 用它 fetch 成 blob，带时间戳只会让每次重新加载都重下一遍头像。
const avatarUrl = (uin: string) => `https://qlogo2.store.qq.com/qzone/${uin}/${uin}/50`;
const rankingMax = computed(() => Math.max(1, ...ranking.value.map((item) => item.interactions)));

/* ------------------------------------------------------------------ 展示用派生状态
 * 以下全部只服务于渲染，不触发任何数据读取，也不改写既有业务流程。 */

/** 概览是否完成过一次真实加载：用来区分「首屏骨架」与「确实还没有回忆」。 */
const overviewLoaded = ref(false);
watch(loading, (current, previous) => {
  if (previous && !current && !dashboardError.value) overviewLoaded.value = true;
});

/** 仅首屏需要骨架；后台静默刷新时保留已有数字，避免闪烁。 */
const firstLoadPending = computed(() => loading.value && !overviewLoaded.value);
const hasMemory = computed(() => overview.value.dynamics > 0 || overview.value.pictures > 0 || recent.value.length > 0);
const interactionTotal = computed(() => overview.value.likes + overview.value.comments);
/** 时间轴上唯一的真实时间锚点：最近保存的那条回忆。 */
const latestMemoryDate = computed(() => {
  const publishedAt = recent.value[0]?.publishedAt;
  if (!publishedAt) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(publishedAt * 1000));
});

/**
 * 备份年份的年份跨度。
 *
 * 取自后端真实的年份列表（listArchiveYears），不是由最近几条推算出来的。
 * 取不到年份时返回 null，界面退回显示最近一条说说的时间锚点。
 */
const yearSpan = computed(() => {
  const years = archiveYears.value;
  if (!years.length) return null;
  const earliest = Math.min(...years);
  const latest = Math.max(...years);
  return {
    label: earliest === latest ? `${earliest} 年` : `${earliest} – ${latest} 年`,
    count: years.length,
  };
});
/** 进行中的任务无法预知总量，用不定长度表示，而不是编造百分比。 */
const progressWidth = computed(() => {
  if (progress.value.status === "completed") return "100%";
  if (progress.value.status === "running") return "32%";
  return "0%";
});

function releaseAvatars() {
  Object.values(avatarSources).forEach((url) => URL.revokeObjectURL(url));
  Object.keys(avatarSources).forEach((uin) => delete avatarSources[uin]);
}
async function loadAvatar(uin: string) {
  if (!uin || avatarSources[uin]) return;
  try {
    const response = await fetch(avatarUrl(uin), {
      method: "GET",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8", Referer: "https://user.qzone.qq.com/" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) throw new Error(`无效头像类型 ${contentType}`);
    avatarSources[uin] = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: contentType }));
  } catch (reason) { console.warn(`QQ ${uin} 头像加载失败`, reason); }
}

async function loadDashboard() {
  if (!loggedIn.value) {
    // 登出要把在途请求一并作废：轮询每 2 秒一次，否则已登出账号的概览、排行与年份会写回界面。
    loadSequence += 1;
    loading.value = false;
    overview.value = { dynamics: 0, pictures: 0, comments: 0, likes: 0, databaseBytes: 0 };
    recent.value = [];
    ranking.value = [];
    archiveYears.value = [];
    return;
  }
  if (loading.value) return;
  const sequence = ++loadSequence;
  loading.value = true;
  dashboardError.value = "";
  try {
    const [stats, items, task, ranks, years] = await Promise.all([
      getArchiveOverview(),
      listArchivedFeeds(3, 0),
      getArchiveProgress(),
      getInteractionRanking(8),
      // 年份跨度取自后端真实的年份列表。带 catch：这一项失败不该拖垮整条加载链。
      listArchiveYears("self").catch(() => [] as number[]),
    ]);
    if (sequence !== loadSequence) return;
    overview.value = stats; recent.value = items; progress.value = task; ranking.value = ranks;
    archiveYears.value = years.filter((year) => year > 0);
    const avatarUins = [...items.flatMap((item) => item.authorUin ? [item.authorUin] : []), ...ranks.map((item) => item.uin)];
    await Promise.all([...new Set(avatarUins)].map(loadAvatar));
  } catch (reason) { if (sequence === loadSequence) dashboardError.value = String(reason); }
  finally { if (sequence === loadSequence) loading.value = false; }
}
async function pollDashboard() {
  if (!loggedIn.value || loading.value) return;
  // 只记录当前序号：轮询期间若发生登出或整块重载，这次结果已经过期，不能写回界面。
  const sequence = loadSequence;
  try {
    const task = await getArchiveProgress();
    if (sequence !== loadSequence || !loggedIn.value) return;
    const wasRunning = progress.value.status === "running";
    progress.value = task;
    if (task.status === "running" || wasRunning) await loadDashboard();
  } catch (reason) {
    console.warn("概览自动刷新失败", reason);
  }
}
function handleVisibilityChange() {
  // 回到前台就重新加载；账号与序号的判断统一在 loadDashboard 内处理。
  if (document.visibilityState === "visible") void loadDashboard();
}
function primaryAction() { loggedIn.value ? router.push("/tasks") : authStore.openLogin(); }
watch(loggedIn, () => {
  // 账号切换先释放上一个账号的头像 blob，否则会一直残留到下次加载。
  releaseAvatars();
  void loadDashboard();
});
onMounted(() => {
  void loadDashboard();
  refreshTimer = window.setInterval(pollDashboard, 2_000);
  document.addEventListener("visibilitychange", handleVisibilityChange);
});
onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  releaseAvatars();
});
</script>

<template>
  <div class="dashboard">
    <ArchiveHeading title="恢复概览" description="查看已保存的说说、照片和互动记录。" :icon="Archive">
      <Button v-if="loggedIn" severity="secondary" outlined :loading="loading" @click="loadDashboard"><RefreshCw :size="16" :stroke-width="1.8" /><span>刷新</span></Button>
    </ArchiveHeading>
    <!-- ------------------------------------------------------ 回忆时光区 -->
    <SectionCard class="memory-hero">
      <div class="memory-hero__inner">
        <EmptyState v-if="dashboardError" :icon="Archive" tone="danger" title="备份总览读取失败" description="请重试，或到「说说」查看已保存的内容。">
          <Button @click="loadDashboard"><RefreshCw :size="16" :stroke-width="1.8" /><span>重试</span></Button>
        </EmptyState>
        <EmptyState
          v-else-if="!loggedIn"
          class="memory-hero__empty"
          compact
          tone="warm"
          :icon="BookOpen"
          title="登录 QQ 空间"
          description="登录后可查找当前账号的历史说说，并保存空间资料。"
        >
          <Button @click="primaryAction">
            <LogIn :size="16" :stroke-width="1.8" />
            <span>登录 QQ 空间</span>
          </Button>
        </EmptyState>

        <div v-else-if="firstLoadPending" class="memory-hero__skeleton">
          <SkeletonBlock width="320px" height="28px" />
          <SkeletonBlock width="min(440px, 100%)" height="14px" />
          <SkeletonBlock width="240px" height="14px" />
        </div>

        <EmptyState
          v-else-if="!hasMemory"
          class="memory-hero__empty"
          compact
          tone="warm"
          :icon="Archive"
          title="还没有保存的内容"
          description="到「恢复任务」开始保存说说。曾有点赞或评论，且记录仍可读取的说说才有机会恢复。"
        >
          <Button severity="secondary" outlined :loading="loading" @click="loadDashboard">
            <RefreshCw :size="16" :stroke-width="1.8" />
            <span>刷新数据</span>
          </Button>
          <Button @click="primaryAction">
            <Download :size="16" :stroke-width="1.8" />
            <span>打开恢复任务</span>
          </Button>
        </EmptyState>

        <template v-else>
          <div class="memory-hero__copy">
            <p class="memory-hero__eyebrow">
              <span class="memory-hero__spark" aria-hidden="true"><Sparkles :size="15" :stroke-width="1.8" /></span>
              <span>本地记录</span>
              <span v-if="user" class="memory-hero__account">QQ {{ user.uin }}</span>
            </p>
            <h2 class="memory-hero__title">已保存到本机</h2>
            <p class="memory-hero__lead">
              已保存 <strong>{{ overview.dynamics.toLocaleString("zh-CN") }}</strong> 条说说，包含 <strong>{{ overview.pictures.toLocaleString("zh-CN") }}</strong> 张配图和
              <strong>{{ interactionTotal.toLocaleString("zh-CN") }}</strong> 次互动记录。
            </p>
            <p v-if="yearSpan" class="memory-hero__stamp">
              <span class="memory-hero__stamp-dot" aria-hidden="true" />
              <span>备份年份 {{ yearSpan.label }} · 共 {{ yearSpan.count }} 个年份</span>
            </p>
            <p v-else-if="latestMemoryDate" class="memory-hero__stamp">
              <span class="memory-hero__stamp-dot" aria-hidden="true" />
              <span>最近一条说说 · {{ latestMemoryDate }}</span>
            </p>
          </div>

          <div class="memory-hero__actions">
            <Button severity="secondary" outlined :loading="loading" @click="loadDashboard">
              <RefreshCw :size="16" :stroke-width="1.8" />
              <span>刷新数据</span>
            </Button>
            <Button @click="primaryAction">
              <Download :size="16" :stroke-width="1.8" />
              <span>打开恢复任务</span>
            </Button>
          </div>
        </template>
      </div>
    </SectionCard>

    <!-- ---------------------------------------------------------- 统计区 -->
    <section v-if="loggedIn && !dashboardError" class="stat-grid" aria-label="备份统计">
      <StatTile
        label="说说"
        :value="overview.dynamics.toLocaleString('zh-CN')"
        hint="已备份的历史动态"
        :icon="MessageSquareQuote"
        tone="accent"
        :loading="firstLoadPending"
      />
      <StatTile
        label="照片"
        :value="overview.pictures.toLocaleString('zh-CN')"
        hint="说说里的配图总数"
        :icon="Images"
        tone="warm"
        :loading="firstLoadPending"
      />
      <StatTile
        label="评论"
        :value="overview.comments.toLocaleString('zh-CN')"
        hint="朋友留下的回复"
        :icon="MessageCircle"
        tone="neutral"
        :loading="firstLoadPending"
      />
      <StatTile
        label="点赞"
        :value="overview.likes.toLocaleString('zh-CN')"
        hint="朋友点过的赞"
        :icon="Heart"
        tone="neutral"
        :loading="firstLoadPending"
      />
      <StatTile
        label="本地占用"
        :value="storageText"
        hint="备份数据库大小"
        :icon="Database"
        tone="neutral"
        :loading="firstLoadPending"
      />
    </section>

    <SectionCard v-if="loggedIn && !dashboardError && (yearSpan || recent.length)" class="year-index" title="按年份查看">
      <nav class="year-index__years" aria-label="按年份翻阅"><RouterLink v-for="year in archiveYears" :key="year" :to="{ path: '/archives', query: { year: String(year) } }"><span>{{ year }}</span><ChevronRight :size="16" :stroke-width="1.8" /></RouterLink></nav>
      <blockquote v-if="recent[0]" class="memory-excerpt"><time>{{ latestMemoryDate }}</time><p class="selectable"><QzoneText :value="recent[0].content" /></p><RouterLink to="/archives">查看说说备份<ChevronRight :size="15" :stroke-width="1.8" /></RouterLink></blockquote>
    </SectionCard>

    <!-- -------------------------------------------- 互动排行 · 最近保存 -->
    <div class="dashboard-columns">
      <SectionCard title="互动排行" description="按点赞与评论的次数排序">
        <template #actions>
          <span v-if="ranking.length" class="rank-badge">TOP {{ ranking.length }}</span>
        </template>

        <div v-if="loggedIn && firstLoadPending" class="rank-list">
          <div v-for="index in 4" :key="index" class="rank-row">
            <SkeletonBlock class="row-avatar-skeleton" width="38px" circle />
            <div class="rank-row__person"><SkeletonBlock :lines="2" /></div>
          </div>
        </div>

        <ol v-else-if="ranking.length" class="rank-list">
          <li
            v-for="(item, index) in ranking"
            :key="item.uin"
            class="rank-row"
            :class="{ 'is-lead': index === 0 }"
          >
            <span class="rank-row__order">{{ index + 1 }}</span>
            <span class="rank-row__avatar">
              <img
                v-if="avatarSources[item.uin]"
                :src="avatarSources[item.uin]"
                alt=""
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
              />
              <User v-else :size="16" :stroke-width="1.8" />
            </span>
            <div class="rank-row__person">
              <strong>{{ item.nickname || item.uin }}</strong>
              <small>{{ item.likes }} 个赞 · {{ item.comments }} 条评论</small>
              <span class="rank-row__bar" aria-hidden="true">
                <i :style="{ width: `${item.interactions / rankingMax * 100}%` }" />
              </span>
            </div>
            <div class="rank-row__count">
              <strong>{{ item.interactions.toLocaleString("zh-CN") }}</strong>
              <small>次互动</small>
            </div>
          </li>
        </ol>

        <EmptyState
          v-else
          compact
          :icon="Users"
          :title="loggedIn ? '还没有互动记录' : '登录后查看互动排行'"
          :description="loggedIn ? '备份完成后，点赞和评论最多的人会排在这里。' : '登录后查看已备份的点赞与评论。'"
        />
      </SectionCard>

      <SectionCard title="最近保存" description="最近保存的三条说说">
        <template #actions>
          <Button text size="small" :disabled="!loggedIn" @click="router.push('/archives')">
            <span>查看全部</span>
            <ChevronRight :size="15" :stroke-width="1.8" />
          </Button>
        </template>

        <div v-if="loggedIn && firstLoadPending" class="recent-list">
          <div v-for="index in 3" :key="index" class="recent-item">
            <SkeletonBlock class="row-avatar-skeleton" width="38px" circle />
            <div class="recent-item__body"><SkeletonBlock :lines="2" /></div>
          </div>
        </div>

        <div v-else-if="recent.length" class="recent-list">
          <article v-for="item in recent" :key="item.id" class="recent-item">
            <span class="recent-item__avatar">
              <img
                v-if="item.authorUin && avatarSources[item.authorUin]"
                :src="avatarSources[item.authorUin]"
                alt=""
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
              />
              <User v-else :size="16" :stroke-width="1.8" />
            </span>
            <div class="recent-item__body">
              <div class="recent-item__head">
                <strong>{{ item.authorName || item.authorUin || "我" }}</strong>
                <small>{{ formatTime(item.publishedAt) }}</small>
              </div>
              <p class="recent-item__text qza-clamp-2"><QzoneText :value="item.content" /></p>
              <div class="recent-item__meta">
                <span><Heart :size="13" :stroke-width="1.8" />{{ item.likeCount }}</span>
                <span><MessageCircle :size="13" :stroke-width="1.8" />{{ item.commentCount }}</span>
              </div>
            </div>
          </article>
        </div>

        <EmptyState
          v-else
          compact
          :icon="MessageSquareQuote"
          :title="loggedIn ? '还没有保存说说' : '尚未登录'"
          :description="loggedIn ? '先在恢复任务里开始一次备份，历史动态会按时间出现在这里。' : '登录 QQ 空间后，这里会显示最近备份的动态。'"
        />
      </SectionCard>
    </div>

    <!-- -------------------------------------------------- 最近任务 -->
    <SectionCard v-if="archiveStore.hasTask" title="最近任务">
      <template #actions>
        <Button text size="small" @click="router.push('/tasks')"><span>{{ archiveStore.running ? '查看进度' : '继续恢复' }}</span><ChevronRight :size="15" :stroke-width="1.8" /></Button>
        <span class="status-chip" :class="`is-${taskSeverity ?? 'secondary'}`">
          <span class="status-chip__dot" aria-hidden="true" />
          <span>{{ taskText ?? "状态未知" }}</span>
        </span>
      </template>

      <div class="archive-status">
        <div class="archive-status__track" :class="{ 'is-running': progress.status === 'running' }" role="progressbar" :aria-valuenow="progress.status === 'completed' ? 100 : undefined" :aria-valuetext="progress.status === 'running' ? '正在读取，剩余数量未知' : taskText" aria-label="备份进度">
          <i :style="{ width: progressWidth }" />
        </div>

        <dl class="archive-status__figures">
          <div>
            <dt>已翻页</dt>
            <dd>{{ progress.pages.toLocaleString("zh-CN") }}</dd>
          </div>
          <div>
            <dt>已读取</dt>
            <dd>{{ progress.fetched.toLocaleString("zh-CN") }}</dd>
          </div>
          <div>
            <dt>已写入</dt>
            <dd>{{ progress.saved.toLocaleString("zh-CN") }}</dd>
          </div>
          <div>
            <dt>已跳过</dt>
            <dd>{{ progress.skipped.toLocaleString("zh-CN") }}</dd>
          </div>
        </dl>

        <p class="archive-status__message">{{ progress.message }}</p>

        <p v-if="archiveStore.hasSkips" class="archive-status__hint">
          有 {{ archiveStore.progress?.skipped ?? 0 }} 页因为接口失败被跳过，可以在恢复任务页里单独重试。
        </p>
      </div>
    </SectionCard>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* ------------------------------------------------------------ 回忆时光区 */

.memory-hero__inner {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-5);
}

.memory-hero__empty,
.memory-hero__skeleton {
  flex: 1 1 100%;
}

/* 暖色底上不能让空状态图标再落回同一层暖色，否则图标圈会消失。 */

.memory-hero__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.memory-hero__copy {
  display: flex;
  flex: 1 1 320px;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-2);
}

.memory-hero__eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.memory-hero__spark {
  display: inline-flex;
  color: var(--color-warm);
}

.memory-hero__account {
  margin-left: auto;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.memory-hero__title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  letter-spacing: -0.01em;
}

.memory-hero__lead {
  max-width: 64ch;
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.memory-hero__lead strong {
  font-weight: var(--weight-semibold);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.memory-hero__stamp {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.memory-hero__stamp-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-warm);
}

.memory-hero__actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* 图标改用 lucide，按钮需要自己对齐图标与文字。 */
.dashboard :deep(.p-button) {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

/* -------------------------------------------------------------- 统计区 */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-4);
}

/* ------------------------------------------------ 互动排行 · 最近保存 */

.dashboard-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  align-items: start;
  gap: var(--space-5);
}

.rank-badge {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.04em;
}

.rank-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.rank-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.rank-row:hover {
  background: var(--color-surface-sunken);
}

.rank-row__order {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.rank-row.is-lead .rank-row__order {
  color: var(--color-accent);
}

/* 骨架头像在 flex 行里必须保住自己的宽度，否则会被压成 0。 */
.rank-row .row-avatar-skeleton,
.recent-item .row-avatar-skeleton {
  flex-shrink: 0;
}

.rank-row__avatar,
.recent-item__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.rank-row__avatar img,
.recent-item__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.rank-row__person {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.rank-row__person strong {
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-row__person small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.rank-row__bar {
  display: block;
  height: 3px;
  margin-top: var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.rank-row__bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
}

.rank-row__count {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: flex-end;
}

.rank-row__count strong {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.rank-row__count small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.recent-list {
  display: flex;
  flex-direction: column;
}

.recent-item {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.recent-item + .recent-item {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--line-width) solid var(--color-border);
}

.recent-item__body {
  flex: 1;
  min-width: 0;
}

.recent-item__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.recent-item__head strong {
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-item__head small {
  flex-shrink: 0;
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.recent-item__text {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.recent-item__meta {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.recent-item__meta span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

/* -------------------------------------------------------- 最近任务 */

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.status-chip__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-text-tertiary);
}

.status-chip.is-success {
  background: var(--color-success-soft);
  border-color: transparent;
  color: var(--color-success);
}

.status-chip.is-success .status-chip__dot {
  background: var(--color-success);
}

.status-chip.is-info {
  background: var(--color-accent-soft);
  border-color: transparent;
  color: var(--color-accent);
}

.status-chip.is-info .status-chip__dot {
  background: var(--color-accent);
  animation: status-pulse 1.6s var(--ease-in-out) infinite;
}

.status-chip.is-warn {
  background: var(--color-warning-soft);
  border-color: transparent;
  color: var(--color-warning);
}

.status-chip.is-warn .status-chip__dot {
  background: var(--color-warning);
}

.status-chip.is-danger {
  background: var(--color-danger-soft);
  border-color: transparent;
  color: var(--color-danger);
}

.status-chip.is-danger .status-chip__dot {
  background: var(--color-danger);
}

@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.archive-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.archive-status__track {
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.archive-status__track > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transition: width var(--duration-slow) var(--ease-out);
}

.archive-status__track.is-running > i {
  animation: archive-slide 1.4s var(--ease-in-out) infinite;
}

@keyframes archive-slide {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(330%);
  }
}

.archive-status__figures {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.archive-status__figures > div {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.archive-status__figures dt {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.archive-status__figures dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.archive-status__message {
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.archive-status__hint {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

/* ------------------------------------------------------------ 响应式 */

@media (max-width: 1080px) {
  .memory-hero :deep(.qza-card__body) {
    padding: var(--space-5);
  }

  .dashboard {
    gap: var(--space-4);
  }

  .dashboard-columns {
    gap: var(--space-4);
  }
}

@media (max-width: 860px) {
  .dashboard-columns {
    grid-template-columns: minmax(0, 1fr);
  }

  .memory-hero__inner {
    align-items: stretch;
  }

  .memory-hero__title {
    font-size: var(--text-xl);
  }

  .memory-hero__account {
    margin-left: 0;
  }
}

.memory-hero :deep(.qza-card__body) { padding: var(--space-8); background: var(--color-surface); border-left: 0; }
.memory-hero { border-radius: var(--radius-xl); }
.memory-hero__empty { text-align: left; align-items: flex-start; padding: var(--space-6); }
.memory-hero__empty :deep(.qza-empty__icon) { width: var(--space-16); height: var(--space-16); background: var(--color-accent-soft); color: var(--color-accent); border-radius: var(--radius-lg); }
.memory-hero__empty :deep(.qza-empty__title) { font-size: var(--text-2xl); font-weight: var(--weight-semibold); }
.memory-hero__empty :deep(.qza-empty__copy) { max-width: 56ch; }
.year-index__years { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.year-index__years a { display: flex; align-items: center; gap: var(--space-6); padding: var(--space-3) var(--space-4); border: var(--line-width) solid var(--color-warm-border); background: var(--color-warm-soft); color: var(--color-warm); border-radius: var(--radius-md); }
.year-index__years span { font-family: var(--font-display); font-size: var(--text-xl); font-variant-numeric: tabular-nums; }
.memory-excerpt { margin: var(--space-6) 0 0; padding: var(--space-5) 0 0 var(--space-5); border-top: var(--line-width) solid var(--color-border); border-left: var(--focus-width) solid var(--color-warm-border); }
.memory-excerpt time { color: var(--color-warm); font-size: var(--text-xs); }
.memory-excerpt p { margin-block: var(--space-3); max-width: 60ch; line-height: var(--leading-relaxed); }
.memory-excerpt a { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
/* 这两条必须晚于上面的 .memory-hero :deep(.qza-card__body) 默认内边距，才能在这个断点生效；
   .dashboard-columns 已在上面 860px 块里声明过，这里不再重复。 */
@media (max-width:860px) { .memory-hero :deep(.qza-card__body) { padding:var(--space-4); } .stat-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }


/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .dashboard { gap:var(--layout-page-gap); }
.memory-hero__inner { align-items:center; gap:var(--space-4); }
.memory-hero__title { font-family:var(--font-display); font-size:var(--text-xl); letter-spacing:normal; }
.memory-hero__lead { font-size:var(--text-sm); line-height:var(--leading-relaxed); }
.memory-hero__stamp { margin-top:var(--space-2); }
.memory-hero__eyebrow { margin-bottom:var(--space-2); }
.memory-hero__actions { align-self:center; }
.stat-grid { gap:var(--density-gap); }
.dashboard-columns { gap:var(--layout-page-gap); align-items:start; }
.rank-row,.recent-item { min-height:var(--density-row-height); padding-block:var(--space-3); }
.year-index__years { gap:var(--space-2); }
.year-index__years a { min-height:var(--control-height); padding:var(--space-2) var(--space-3); font-size:var(--text-base); }
.memory-excerpt { margin-top:var(--space-4); padding:var(--space-3) var(--space-4); background:var(--color-surface-sunken); border-radius:var(--radius-md); }
@media(min-width:1100px) { .dashboard-columns { grid-template-columns:minmax(0,1fr) minmax(0,1.4fr); } }
@media(max-width:600px) { .memory-hero__actions { width:100%; } .stat-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }

@media(min-width:1100px) {
 .dashboard { display:grid; grid-template-columns:minmax(0,2.2fr) minmax(var(--layout-contact-cell),1fr); align-items:start; }
 .dashboard > .archive-heading,.dashboard > .memory-hero,.dashboard > .stat-grid { grid-column:1 / -1; }
 .dashboard > .year-index { grid-column:1; }
 .dashboard > .dashboard-columns { grid-column:2; grid-row:4 / span 2; display:flex; flex-direction:column; gap:var(--layout-page-gap); }
 .dashboard-columns > * { width:100%; }
 .dashboard > .qza-card:last-child:not(.memory-hero):not(.year-index) { grid-column:1; }
}
</style>
