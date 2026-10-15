import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { getArchiveProgress, IDLE_ARCHIVE_PROGRESS, type ArchiveProgress } from "../utils/qzone";

/** 任务进行中时的轮询间隔。 */
const ACTIVE_INTERVAL_MS = 2000;
/** 空闲时的轮询间隔。侧边栏需要常驻显示状态，但没任务时没必要每 2 秒问一次。 */
const IDLE_INTERVAL_MS = 15000;

/**
 * 归档进度的全局状态。
 *
 * 侧边栏要在任何页面都显示同步状态，归档任务页也要读同一份进度，
 * 因此把轮询收拢到这里，避免两处各自订阅导致重复请求与状态不一致。
 */
export const useArchiveStore = defineStore("archive", () => {
  const progress = ref<ArchiveProgress | null>(null);
  const error = ref("");

  let timer: number | null = null;
  let polling = false;
  let pollRevision = 0;
  /** 进行中的刷新请求。并发调用共享同一个 Promise，见 refresh()。 */
  let pending: Promise<void> | null = null;
  let revision = 0;
  let pendingRevision = -1;
  const taskPending = ref(false);

  const running = computed(() => taskPending.value || progress.value?.status === "running");
  const limited = computed(() => progress.value?.status === "limited");
  const completed = computed(() => progress.value?.status === "completed");
  const hasTask = computed(() => progress.value !== null);
  /**
   * 资料同步（相册、照片、视频等）是否在跑。
   *
   * 它和归档任务是两条独立路径：归档走 start_feed_archive，资料同步走
   * sync_qzone_library，后者原先不体现在任何共享状态里，页面内自己管自己。
   * 后端现在把同步中标记放进进度轮询，这里读出来给全局用。
   */
  const syncing = computed(() => progress.value?.librarySyncing === true);
  /**
   * 是否有任何任务在往归档数据里写。
   *
   * 设置页的清空、删除与退出登录必须以这个为准，不能只看 running ——
   * 资料同步跑到一半时点清空，后续页会把刚删掉的数据补回去；换号则会把另一个
   * 账号的数据混进当前账号。
   */
  const busy = computed(() => running.value === true || syncing.value);

  /** 是否出现了未解决的跳页记录（断点续传的异常条目）。 */
  const hasSkips = computed(() => (progress.value?.skipped ?? 0) > 0);

  // The native start command returns only when the entire run ends. Show the new
  // run immediately, and reject snapshots requested before either action boundary.
  function beginRun() {
    revision += 1;
    taskPending.value = true;
    progress.value = {
      ...IDLE_ARCHIVE_PROGRESS,
      status: "running",
      message: "正在从上次断点继续读取…",
      librarySyncing: progress.value?.librarySyncing ?? false,
    };
    error.value = "";
    reschedule();
  }

  function finishRun(snapshot?: ArchiveProgress) {
    revision += 1;
    taskPending.value = false;
    if (snapshot) progress.value = snapshot;
    reschedule();
  }

  /**
   * 拉取一次进度。
   *
   * 并发调用时**共享同一个进行中的 Promise**,而不是直接返回 undefined——
   * 否则紧跟「开始/停止归档」的那次刷新会被丢弃，调用方读到的仍是旧状态。
   */
  function refresh(): Promise<void> {
    if (pending && pendingRevision === revision) return pending;
    const requestedRevision = revision;
    pendingRevision = requestedRevision;
    const request = (async () => {
      try {
        const snapshot = await getArchiveProgress();
        if (requestedRevision !== revision) return;
        // A pre-start idle/partial response may arrive after IPC dispatch. The
        // pending start command supplies the authoritative terminal snapshot.
        if (!taskPending.value || snapshot.status === "running") progress.value = snapshot;
        error.value = "";
      } catch (reason) {
        if (requestedRevision === revision) error.value = String(reason);
      } finally {
        if (pendingRevision === requestedRevision) pending = null;
      }
    })();
    pending = request;
    return request;
  }

  function reschedule() {
    pollRevision += 1;
    if (timer !== null) window.clearTimeout(timer);
    schedule();
  }

  function schedule() {
    if (!polling) return;
    // 资料同步期间也走活跃间隔：设置页要靠这份状态去禁用清空/删除/退出登录，
    // 15 秒的延迟足够用户点下去。
    const delay = busy.value || limited.value ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    const scheduledRevision = pollRevision;
    timer = window.setTimeout(async () => {
      if (!polling || scheduledRevision !== pollRevision) return;
      await refresh();
      if (scheduledRevision === pollRevision) schedule();
    }, delay);
  }

  /** 幂等：重复调用不会叠加计时器。 */
  function startPolling() {
    if (polling) return;
    polling = true;
    void refresh();
    schedule();
  }

  function stopPolling() {
    polling = false;
    pollRevision += 1;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  return {
    progress,
    error,
    running,
    syncing,
    busy,
    limited,
    completed,
    hasTask,
    hasSkips,
    beginRun,
    finishRun,
    refresh,
    startPolling,
    stopPolling,
  };
});
