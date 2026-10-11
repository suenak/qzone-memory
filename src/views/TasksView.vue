<script setup lang="ts">
import { describeError, diagnosticError } from "../utils/uiError";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import { LogIn, X,
  Archive,
  Calendar,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Database,
  Download,
  HardDriveDownload,
  Info,
  KeyRound,
  Layers,
  ListChecks,
  Lock,
  RefreshCw,
  ShieldAlert,
} from "lucide-vue-next";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import ArchiveHeading from "../components/ui/ArchiveHeading.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import StatTile from "../components/ui/StatTile.vue";
import {
  cancelFeedArchive, getArchiveProgress, listArchiveSkips, retryArchiveSkip, startFeedArchive,
  IDLE_ARCHIVE_PROGRESS, type ArchiveProgress, type ArchiveSkipItem, type ArchiveStatus,
} from "../utils/qzone";
import { useArchiveStore } from "../stores/archive";
import { useAuthStore } from "../stores/auth";
import { useLicenseStore } from "../stores/license";
import { MAX_ARCHIVE_INTERVAL, MIN_ARCHIVE_INTERVAL, getArchiveInterval, setArchiveInterval } from "../utils/appSettings";

const authStore = useAuthStore();
const archiveStore = useArchiveStore();
const licenseStore = useLicenseStore();
const { loggedIn } = storeToRefs(authStore);
const progress = computed<ArchiveProgress>(() => archiveStore.progress ?? IDLE_ARCHIVE_PROGRESS);
const skips = ref<ArchiveSkipItem[]>([]);
const retryingId = ref<number>();
const skipNotice = ref("");
const actionError = ref("");
const starting = ref(false);
const stopping = ref(false);
const refreshing = ref(false);
const skipsError = ref("");
const currentTime = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const running = computed(() => progress.value.status === "running");
const rateLimited = computed(() => progress.value.status === "limited");
const remainingSeconds = computed(() => Math.max(0, Math.ceil((Number(progress.value.retryAt || 0) * 1000 - currentTime.value) / 1000)));
const rateWaiting = computed(() => rateLimited.value && remainingSeconds.value > 0);
const remainingText = computed(() => `${String(Math.floor(remainingSeconds.value / 60)).padStart(2, "0")}:${String(remainingSeconds.value % 60).padStart(2, "0")}`);
const statusText = computed(() => ({ idle: "未开始", running: "进行中", completed: "已完成", cancelled: "已取消", limited: "稍后继续", error: "失败" }[progress.value.status]));

/* ---------------------------------------------------------------------- UI 层
 * 以下只为呈现服务：状态卡文案、配色、展开状态、备份间隔草稿。
 * 业务状态仍由上面的 progress / skips 保管，未做任何改动。 */

/** 状态色：进行中用主色，完成用成功色，限流与取消用警告色，失败用危险色。 */
const statusTone = computed<"accent" | "success" | "warning" | "danger" | "neutral">(() => {
  const tones: Record<ArchiveStatus, "accent" | "success" | "warning" | "danger" | "neutral"> = {
    idle: "neutral",
    running: "accent",
    completed: "success",
    cancelled: "warning",
    limited: "warning",
    error: "danger",
  };
  return tones[progress.value.status];
});

/** 状态标题：一眼看懂「现在在做什么」。 */
const statusTitle = computed(() => ({
  idle: "等待开始",
  running: "正在备份空间动态",
  completed: "本次备份已完成",
  cancelled: "备份已停止",
  limited: "请求过于频繁，已暂停",
  error: "备份未完成",
}[progress.value.status]));

/** 状态说明：解释「为什么」以及「下一步」。 */
const statusDescription = computed(() => ({
  idle: "开始后会逐页读取空间记录，保存到本机。",
  running: "正在读取并保存。请保持应用运行，不要切换 QQ 账号。",
  completed: "本轮读取已结束，可到「说说」查看结果。",
  cancelled: "已保存的内容会保留，下次可继续备份。",
  limited: "QQ 空间暂时限制了请求。等待倒计时结束后，点击「继续备份」。",
  error: "已保存的内容会保留。请查看错误提示后重试。",
}[progress.value.status]));

/** 操作按钮文案：把「现在能不能点、点了会发生什么」写在按钮上。 */
const startLabel = computed(() => {
  if (running.value) return "备份中…";
  if (rateWaiting.value) return `请等待 ${remainingText.value}`;
  if (rateLimited.value) return "继续备份";
  if (progress.value.status === "cancelled" || progress.value.status === "error") return "继续备份";
  if (progress.value.status === "completed") return "检查新内容";
  return "开始备份";
});

const skipBadge = computed(() => skips.value.filter((item) => !item.resolvedAt).length);
const detailsOpen = ref(false);
const loginNoticeVisible = computed(() => !loggedIn.value);
/** 备份进度尚未取回一次：此时用骨架而不是把 0 当成真实数据。 */
const statsLoading = computed(() => !archiveStore.hasTask && !archiveStore.error && loggedIn.value);

const intervalDraft = ref(getArchiveInterval());
const intervalHint = computed(() => `每页等待 ${(intervalDraft.value / 1000).toFixed(1)} 秒，较长的间隔可减少频繁请求。`);

/* 输入框绑到 `intervalInputValue` 草稿：若直接绑到带 clamp 的 setter，用户想输 10000ms 时，
 * 第一个 "1" 会被改成 2000，后续输入得到 20000 而不是 10000。
 * 这里只保留用户输入的原始值，blur / 回车时才归一化并保存。 */
const intervalInputValue = ref(intervalDraft.value / 1000);
/** 归一化并保存：只在提交（blur / 回车）时执行，输入过程中不篡改用户输入。 */
function commitIntervalInput() {
  const seconds = typeof intervalInputValue.value === "number" && Number.isFinite(intervalInputValue.value)
    ? intervalInputValue.value
    : intervalDraft.value / 1000;
  const normalized = setArchiveInterval(seconds * 1000);
  intervalDraft.value = normalized;
  intervalInputValue.value = normalized / 1000;
}

/* 刚由 start / cancel 写入的进度在此刻之前视为权威：侧边栏轮询是「更早发出」的请求，
 * 它的响应回来时不能把按钮状态改回旧值（「停止备份」变回「备份中」）。
 * archive.ts 是父任务负责的文件，这里不引入跨文件的新接口，只在组件内做短 TTL 保护。 */
const PROGRESS_FRESH_MS = 2500;
let progressFreshAt = 0;
function markProgressFresh() { progressFreshAt = Date.now(); }
function progressIsFresh() { return Date.now() - progressFreshAt < PROGRESS_FRESH_MS; }

/** 取一次最新进度；已有在飞请求时返回同一个 Promise，调用方 await 到的一定是新值。
 *  不走 archiveStore.refresh()：它遇到在飞请求会直接 return，调用方随后读到的还是旧值。 */
let refreshPromise: Promise<void> | null = null;
async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshing.value = true;
  refreshPromise = (async () => {
    try {
      try {
        const snapshot = await getArchiveProgress();
        // 旧轮询响应在 start/cancel 写入之后才返回：丢弃，避免按钮状态回跳。
        if (!progressIsFresh()) { archiveStore.progress = snapshot; archiveStore.error = ""; }
      } catch (reason) {
        // 落在与 store 相同的错误面上，进度读取失败时模板照旧给出提示。
        archiveStore.error = String(reason);
      }
      if (!loggedIn.value) { skips.value = []; return; }
      try { skips.value = await listArchiveSkips(); skipsError.value = ""; }
      catch (reason) { skipsError.value = describeError(reason, "跳页记录读取失败，请刷新重试。"); }
    } finally { refreshing.value = false; refreshPromise = null; }
  })();
  return refreshPromise;
}
async function start() {
  if (!loggedIn.value || starting.value || running.value || rateWaiting.value || !licenseStore.canArchive) return;
  starting.value = true;
  actionError.value = "";
  try {
    archiveStore.progress = await startFeedArchive(getArchiveInterval());
    // 紧接其后的 refresh（含侧边栏轮询）不得用旧快照覆盖刚拿到的状态。
    markProgressFresh();
  }
  catch (reason) { actionError.value = describeError(reason, "未能开始备份，请重试。"); }
  finally { starting.value = false; await refresh(); }
}
async function cancel() {
  if (stopping.value) return;
  stopping.value = true;
  actionError.value = "";
  try {
    await cancelFeedArchive();
    markProgressFresh();
  }
  catch (reason) { actionError.value = describeError(reason, "未能停止备份，请重试。"); }
  finally { stopping.value = false; await refresh(); }
}
async function retrySkip(item: ArchiveSkipItem) {
  retryingId.value = item.id;
  skipNotice.value = "";
  try {
    const result = await retryArchiveSkip(item.id);
    skipNotice.value = result.message;
  } catch (error) {
    skipNotice.value = describeError(error, "重试此页失败，请稍后再试。");
  } finally {
    retryingId.value = undefined;
    await refresh();
  }
}
function formatTime(timestamp?: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
}
function offsetLabel(item: ArchiveSkipItem) {
  if (item.offsetAdvance <= 0) return `${item.cursorOffset}（待定位）`;
  const end = item.cursorOffset + item.offsetAdvance - 1;
  return end > item.cursorOffset ? `${item.cursorOffset}–${end}` : String(item.cursorOffset);
}
onMounted(async () => {
  // 进度与侧边栏共用 stores/archive.ts 这一份轮询，本页不再自建定时器。
  archiveStore.startPolling();
  currentTime.value = Date.now();
  // 定时器必须在第一个 await 之前建立：否则 await 期间用户切走页面时，
  // onBeforeUnmount 清理的 timer 还是 undefined，定时器会带着已卸载组件一直跑。
  timer = setInterval(() => { currentTime.value = Date.now(); }, 1000);
  await refresh();
});
watch(() => archiveStore.progress?.status, (status, previous) => {
  if (previous === "running" && status !== "running") void refresh();
});
watch(loggedIn, refresh);
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="tasks-page">
    <ArchiveHeading title="备份任务" description="保存说说和互动记录，离开此页不会中断备份。" :icon="Archive" />
    <!-- ------------------------------------------------------- 任务状态卡 -->
    <SectionCard
      title="空间动态备份"
      description="从互动记录里逐页取回历史动态，写入本地数据。"
    >
      <template #actions>
        <span class="status-chip" :class="`is-${statusTone}`">
          <span class="status-chip__dot" aria-hidden="true" />
          {{ statusText }}
        </span>
        <button class="ghost-button" type="button" :disabled="refreshing" @click="refresh">
          <RefreshCw :size="16" :stroke-width="1.8" />
          <span class="ghost-button__text">刷新进度</span>
        </button>
      </template>

      <p v-if="archiveStore.error" class="skip-notice" role="alert">{{ describeError(archiveStore.error, "备份状态读取失败，请刷新进度。") }}</p>
      <p v-if="actionError" class="skip-notice" role="alert">{{ actionError }}</p>
      <p v-if="loggedIn && !licenseStore.canArchive" class="skip-notice">当前授权仅支持查看和导出，更新授权后可开始备份。</p>
      <SkeletonBlock v-if="statsLoading" :lines="3" height="18px" />

      <template v-else>
        <div class="status-panel" :class="`is-${statusTone}`">
          <span class="status-panel__icon" aria-hidden="true">
            <component
              :is="{
                idle: CircleSlash,
                running: HardDriveDownload,
                completed: CircleCheck,
                cancelled: CircleSlash,
                limited: Clock,
                error: CircleAlert,
              }[progress.status]"
              :size="20"
              :stroke-width="1.8"
            />
          </span>
          <div class="status-panel__copy">
            <strong>{{ statusTitle }}</strong>
            <p>{{ statusDescription }}</p>
          </div>
        </div>

        <!-- 进度没有总任务量，因此只做不确定进度提示，不画百分比进度条。 -->
        <div v-if="running || rateLimited" class="indeterminate" role="progressbar" aria-label="备份进行中" aria-valuetext="无法预估剩余量">
          <span class="indeterminate__bar" />
        </div>

        <p v-show="detailsOpen" class="engine-message">
          <Info :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ diagnosticError(progress.message) }}</span>
        </p>

        <div v-if="rateWaiting" class="notice is-warning">
          <span class="notice__icon" aria-hidden="true">
            <Clock :size="18" :stroke-width="1.8" />
          </span>
          <div class="notice__copy">
            <strong>{{ remainingText }} 后可继续</strong>
            <p>进度已保存，等待结束后可继续备份。</p>
          </div>
          <span class="notice__timer">{{ remainingText }}</span>
        </div>

        <div v-else-if="rateLimited" class="notice is-warning">
          <span class="notice__icon" aria-hidden="true">
            <Clock :size="18" :stroke-width="1.8" />
          </span>
          <div class="notice__copy">
            <strong>现在可以继续备份</strong>
            <p>点击「继续备份」，接着读取上次未完成的内容。</p>
          </div>
        </div>

        <div v-if="loginNoticeVisible" class="notice is-accent">
          <span class="notice__icon" aria-hidden="true">
            <Lock :size="18" :stroke-width="1.8" />
          </span>
          <div class="notice__copy">
            <strong>请先登录 QQ 空间</strong>
            <p>登录后才能创建或继续备份任务。</p>
          </div>
          <Button label="登录 QQ 空间" size="small" @click="authStore.openLogin" ><template #icon><LogIn :size="16" :stroke-width="1.8" /></template></Button>
        </div>

        <div class="stat-grid">
          <StatTile label="已读取页数" :value="archiveStore.hasTask ? progress.pages : '—'" :icon="Layers" tone="accent" :loading="statsLoading" hint="按互动列表翻页" />
          <StatTile label="已读取记录" :value="archiveStore.hasTask ? progress.fetched : '—'" :icon="Download" tone="neutral" :loading="statsLoading" hint="本次读取到的记录" />
          <StatTile label="已保存记录" :value="archiveStore.hasTask ? progress.saved : '—'" :icon="Database" tone="success" :loading="statsLoading" hint="已保存到本机的记录" />
          <StatTile label="跳过页数" :value="archiveStore.hasTask ? progress.skipped : '—'" :icon="ShieldAlert" tone="warm" :loading="statsLoading" hint="跳过的请求页" />
        </div>
      </template>

      <template #footer>
        <div class="action-bar">
          <div class="action-bar__buttons">
            <Button :label="startLabel" :loading="starting" :disabled="running || rateWaiting || !loggedIn || !licenseStore.canArchive" @click="start" ><template #icon><Download :size="16" :stroke-width="1.8" /></template></Button>
            <Button v-if="running" label="停止备份" severity="secondary" outlined :loading="stopping" @click="cancel" ><template #icon><X :size="16" :stroke-width="1.8" /></template></Button>
            <button
              class="ghost-button"
              type="button"
              :aria-expanded="detailsOpen"
              aria-controls="task-technical-details"
              @click="detailsOpen = !detailsOpen"
            >
              <ListChecks :size="16" :stroke-width="1.8" />
              <span class="ghost-button__text">运行详情</span>
              <span v-if="skipBadge" class="ghost-button__badge">{{ skipBadge }}</span>
              <ChevronDown class="ghost-button__chevron" :class="{ 'is-open': detailsOpen }" :size="15" :stroke-width="1.8" />
            </button>
          </div>

          <div class="interval-field">
            <label for="archive-interval">
              <Calendar :size="15" :stroke-width="1.8" aria-hidden="true" />
              每页间隔
            </label>
            <!-- 只更新草稿，blur / 回车时才归一化保存：输入过程中不篡改用户输入。 -->
            <InputNumber
              input-id="archive-interval"
              v-model="intervalInputValue"
              :min="MIN_ARCHIVE_INTERVAL / 1000"
              :max="MAX_ARCHIVE_INTERVAL / 1000"
              :step="0.5"
              :max-fraction-digits="1"
              suffix=" 秒"
              :disabled="running"
              show-buttons
              @blur="commitIntervalInput"
              @keydown.enter="commitIntervalInput"
            />
            <small>{{ intervalHint }}</small>
          </div>
        </div>
      </template>
    </SectionCard>

    <!-- ------------------------------------------------- 运行详情：跳页记录 -->
    <div v-show="detailsOpen" id="task-technical-details" class="details">
      <SectionCard
        title="跳页记录"
        description="未能读取的页会列在这里，可以逐页重试。"
      >
        <p v-if="skipsError" role="alert" class="skip-notice">{{ skipsError }}</p>
        <template #actions>
          <span v-if="skipBadge" class="count-chip is-warning">{{ skipBadge }} 条待重试</span>
          <span v-else class="count-chip is-success">没有待重试条目</span>
        </template>

        <p v-if="skipNotice" class="skip-notice">
          <Info :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ describeError(skipNotice, skipNotice) }}</span>
        </p>

        <ul v-if="skips.length" class="skip-list">
          <li
            v-for="item in skips"
            :key="item.id"
            class="skip-item"
            :class="{ 'is-resolved': item.resolvedAt }"
          >
            <span class="skip-item__state" aria-hidden="true">
              <component :is="item.resolvedAt ? CircleCheck : CircleAlert" :size="18" :stroke-width="1.8" />
            </span>
            <div class="skip-item__copy">
              <div class="skip-item__head">
                <strong>第 {{ item.pageNumber }} 页 · 记录位置 {{ offsetLabel(item) }}</strong>
                <span class="count-chip" :class="item.resolvedAt ? 'is-success' : 'is-warning'">
                  {{ item.resolvedAt ? "已恢复" : "待重试" }}
                </span>
              </div>
              <p class="skip-item__error">{{ diagnosticError(item.error) }}</p>
              <small>
                跳过于 {{ formatTime(item.skippedAt) }}<template v-if="item.retryCount"> · 已重试 {{ item.retryCount }} 次 · 最近 {{ formatTime(item.lastRetryAt) }}</template><template v-if="item.resolvedAt"> · 恢复 {{ item.recoveredRecords }} 条</template>
              </small>
            </div>
            <Button
              :label="retryingId === item.id ? '重试中…' : item.resolvedAt ? '已恢复' : '重试此页'"

              size="small"
              outlined
              :loading="retryingId === item.id"
              :disabled="running || Boolean(item.resolvedAt) || retryingId !== undefined"
              @click="retrySkip(item)"
            ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
          </li>
        </ul>

        <EmptyState
          v-else
          :icon="CircleCheck"
          title="没有跳过的请求页"
          description="未能读取的页会列在这里，目前没有待重试记录。"
          compact
        />
      </SectionCard>
    </div>

    <!-- ------------------------------------------------------------ 使用提示 -->
    <SectionCard title="备份须知">
      <ul class="tips">
        <li>
          <span class="tips__icon" aria-hidden="true"><KeyRound :size="16" :stroke-width="1.8" /></span>
          <span>空间内容的获取基于 QQ 空间的<strong>互动列表</strong>。没有被点赞或评论过的动态无法被恢复。</span>
        </li>
        <li>
          <span class="tips__icon" aria-hidden="true"><Clock :size="16" :stroke-width="1.8" /></span>
          <span>出现<strong>频繁提示</strong>时建议换个时间再继续。程序支持<strong>断点续传</strong>，可以接着上次的进度继续备份。</span>
        </li>
        <li>
          <span class="tips__icon" aria-hidden="true"><Archive :size="16" :stroke-width="1.8" /></span>
          <span>备份过程中<strong>不要切换 QQ 客户端账号</strong>，否则可能有冻结风险。</span>
        </li>
      </ul>
    </SectionCard>
  </div>
</template>

<style scoped>
.tasks-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

/* ------------------------------------------------------------ 状态胶囊 */

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
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.status-chip__dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: currentColor;
}

.status-chip.is-accent {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.status-chip.is-success {
  border-color: transparent;
  background: var(--color-success-soft);
  color: var(--color-success);
}

.status-chip.is-warning {
  border-color: transparent;
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.status-chip.is-danger {
  border-color: transparent;
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* 运行中的呼吸点，暗示任务仍在推进。 */
.status-chip.is-accent .status-chip__dot {
  animation: task-pulse 1.6s ease-in-out infinite;
}

@keyframes task-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}

/* -------------------------------------------------------- 状态说明面板 */

.status-panel__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.status-panel__copy {
  min-width: 0;
}

.status-panel__copy p {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.status-panel.is-accent {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
}

.status-panel.is-accent .status-panel__icon {
  color: var(--color-accent);
}

.status-panel.is-success {
  border-color: transparent;
  background: var(--color-success-soft);
}

.status-panel.is-success .status-panel__icon {
  color: var(--color-success);
}

.status-panel.is-warning {
  border-color: var(--color-warm-border);
  background: var(--color-warning-soft);
}

.status-panel.is-warning .status-panel__icon {
  color: var(--color-warning);
}

.status-panel.is-danger {
  border-color: transparent;
  background: var(--color-danger-soft);
}

.status-panel.is-danger .status-panel__icon {
  color: var(--color-danger);
}

/* --------------------------------------------------- 不确定进度指示条 */

.indeterminate {
  position: relative;
  height: 4px;
  margin-top: var(--space-3);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.indeterminate__bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 40%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: task-indeterminate 1.5s var(--ease-in-out) infinite;
}

@keyframes task-indeterminate {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(280%); }
}

/* ------------------------------------------------------------ 说明条 */

.engine-message {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}

.engine-message svg {
  flex-shrink: 0;
  margin-top: var(--space-1);
}

.notice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.notice__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.notice__copy {
  flex: 1;
  min-width: 0;
}

.notice__copy strong {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.notice__copy p {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.notice__timer {
  flex-shrink: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--color-warning);
}

.notice.is-warning {
  border-color: var(--color-warm-border);
  background: var(--color-warning-soft);
}

.notice.is-warning .notice__icon {
  color: var(--color-warning);
}

.notice.is-accent {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
}

.notice.is-accent .notice__icon {
  color: var(--color-accent);
}

/* ------------------------------------------------------------ 统计网格 */
/* 统计网格 / 操作区 / 状态面板的主规则集中在文件末尾，这里只保留注释锚点。 */

/* ------------------------------------------------------------ 操作区 */

.ghost-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  padding: 0 var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  transition: border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.ghost-button:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.ghost-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ghost-button__badge {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  background: var(--color-warning);
  color: var(--color-text-inverse);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.ghost-button__chevron {
  transition: transform var(--duration-fast) var(--ease-out);
}

.ghost-button__chevron.is-open {
  transform: rotate(180deg);
}

.interval-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.interval-field label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.interval-field small {
  flex-basis: 100%;
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}

/* -------------------------------------------------- 运行详情：跳页记录 */

.details {
  min-width: 0;
}

.count-chip {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.count-chip.is-warning {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.count-chip.is-success {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.skip-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: var(--line-width) solid var(--color-accent-border);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.skip-notice svg {
  flex-shrink: 0;
  margin-top: var(--space-1);
}

.skip-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.skip-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.skip-item.is-resolved {
  opacity: 0.72;
}

.skip-item__state {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.skip-item.is-resolved .skip-item__state {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.skip-item__copy {
  min-width: 0;
}

.skip-item__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.skip-item__head strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
}

.skip-item__error {
  margin-top: var(--space-1);
  overflow: hidden;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
}

.skip-item__copy small {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

/* ------------------------------------------------------------ 使用提示 */

.tips {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.tips li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.tips li strong {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.tips__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}

/* ------------------------------------------------------------ 响应式 */

@media (max-width: 1080px) {
  .stat-grid {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
}

@media (max-width: 860px) {
  .stat-grid {
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-2);
  }

  .action-bar {
    align-items: stretch;
  }

  .action-bar__buttons {
    width: 100%;
  }

  .action-bar__buttons > * {
    flex: 1 1 auto;
    min-width: 0;
  }

  .ghost-button {
    justify-content: center;
    /* 原先这条写在文件末尾重复的同断点媒体查询里，现合并到本块。 */
    min-height: var(--touch-target);
  }

  .notice {
    flex-wrap: wrap;
  }

  .interval-field {
    width: 100%;
  }

  .interval-field label {
    flex-basis: 100%;
  }

  .skip-item {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .skip-item > .p-button {
    grid-column: 1 / -1;
    width: 100%;
  }
}

@media (max-width: 560px) {
  .ghost-button__text,
  .status-chip {
    display: none;
  }

  .ghost-button {
    justify-content: center;
  }
}

.status-panel {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  border: var(--line-width) solid var(--color-border);
  background: var(--color-surface-sunken); padding:var(--space-6); border-radius:var(--radius-lg); }
.status-panel__copy strong {
  display: block;
  font-weight: var(--weight-semibold); font-size:var(--text-xl); }
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  margin-top: var(--space-5); gap:var(--space-3); }
.action-bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap; gap:var(--space-6); }
.action-bar__buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2); flex-wrap:wrap; }

</style>
