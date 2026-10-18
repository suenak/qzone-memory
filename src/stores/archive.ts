import { defineStore } from "pinia";
import { computed, onScopeDispose, ref } from "vue";
import { getArchiveProgress, IDLE_ARCHIVE_PROGRESS, retryArchiveSkip, syncQzoneLibrary, type ArchiveProgress, type LibraryModule } from "../utils/qzone";

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
  const pendingLibrarySyncs = ref(0);
  const retryingSkipId = ref<number>();
  const retrying = computed(() => retryingSkipId.value !== undefined);
  const dataChanging = ref(false);
  const recoveringRecycle = ref(false);

  const running = computed(() => taskPending.value || progress.value?.status === "running");
  const limited = computed(() => progress.value?.status === "limited");
  const completed = computed(() => progress.value?.status === "completed");
  const hasTask = computed(() => progress.value !== null);
  /**
   * 资料同步（相册、照片、视频等）是否在跑。
   *
   * 它和归档任务是两条独立路径：归档走 start_feed_archive，资料同步走
   * sync_qzone_library，后者原先不体现在任何共享状态里，页面内自己管自己。
   * IPC 发出前立即标记，避免等待空闲轮询。页面卸载不会提前解除标记；
   * 原生层报告的同步状态仍作为补充，兼容其他入口启动的同步。
   */
  const syncing = computed(() => pendingLibrarySyncs.value > 0 || progress.value?.librarySyncing === true);
  /**
   * 是否有需要保持账号与数据稳定的操作在进行。
   *
   * 设置页的清空、删除与退出登录必须以这个为准，不能只看 running；
   * 单页重试也会持续写库，必须等原生请求结束后才能解除忙碌状态。
   * 资料同步跑到一半时点清空，后续页会把刚删掉的数据补回去；换号则会把另一个
   * 账号的数据混进当前账号。
   * 回收站恢复也使用当前 QQ 身份，原生请求结束前不能换号或删除账号数据。
   */
  const busy = computed(() => running.value === true || syncing.value || retrying.value || dataChanging.value || recoveringRecycle.value);

  /** 是否出现了未解决的跳页记录（断点续传的异常条目）。 */
  const hasSkips = computed(() => (progress.value?.skipped ?? 0) > 0);

  // The native start command returns only when the entire run ends. Show the new
  // run immediately, and reject snapshots requested before either action boundary.
  function beginRun() {
    if (recoveringRecycle.value) throw new Error("回收站恢复进行中，请等待完成后再开始任务。");
    if (dataChanging.value) throw new Error("本地数据正在整理，请等待完成后再恢复。");
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

  /** Own the native command's lifetime independently of the page that started it. */
  async function syncLibrary(module: LibraryModule, parentKey?: string) {
    if (recoveringRecycle.value) throw new Error("回收站恢复进行中，请等待完成后再备份资料。");
    if (dataChanging.value) throw new Error("本地数据正在整理，请等待完成后再备份资料。");
    if (retrying.value) throw new Error("异常页重试进行中，请等待结束后再备份资料。");
    revision += 1;
    pendingLibrarySyncs.value += 1;
    reschedule();
    try {
      return await syncQzoneLibrary(module, parentKey);
    } finally {
      revision += 1;
      pendingLibrarySyncs.value -= 1;
      reschedule();
      // A response requested during the sync can still say "syncing" after it
      // finishes. Read a fresh snapshot without delaying the command's result.
      void refresh();
    }
  }

  async function retrySkip(id: number) {
    if (busy.value) throw new Error("请等待当前恢复或资料同步结束后再重试。");
    revision += 1;
    retryingSkipId.value = id;
    reschedule();
    try {
      return await retryArchiveSkip(id);
    } finally {
      revision += 1;
      retryingSkipId.value = undefined;
      reschedule();
      void refresh();
    }
  }

  /** Keep data changes busy through their native work and required cleanup. */
  async function withDataChange<T>(operation: () => Promise<T>): Promise<T> {
    if (busy.value) throw new Error("请等待当前任务结束后再修改本地数据。");
    revision += 1;
    dataChanging.value = true;
    reschedule();
    try {
      return await operation();
    } finally {
      revision += 1;
      dataChanging.value = false;
      reschedule();
      void refresh();
    }
  }

  /** Keep account/data actions blocked until the in-flight QQ recovery settles. */
  async function withRecycleRecovery<T>(operation: () => Promise<T>): Promise<T> {
    if (busy.value) throw new Error("请等待当前任务结束后再恢复回收站内容。");
    revision += 1;
    recoveringRecycle.value = true;
    reschedule();
    try {
      return await operation();
    } finally {
      revision += 1;
      recoveringRecycle.value = false;
      reschedule();
      void refresh();
    }
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

  onScopeDispose(stopPolling);

  return {
    progress,
    error,
    running,
    syncing,
    retrying,
    retryingSkipId,
    dataChanging,
    recoveringRecycle,
    withRecycleRecovery,
    busy,
    limited,
    completed,
    hasTask,
    hasSkips,
    beginRun,
    finishRun,
    syncLibrary,
    retrySkip,
    withDataChange,
    refresh,
    startPolling,
    stopPolling,
  };
});
