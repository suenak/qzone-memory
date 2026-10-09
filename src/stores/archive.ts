import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { getArchiveProgress, type ArchiveProgress } from "../utils/qzone";

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
  let refreshing = false;

  const running = computed(() => progress.value?.status === "running");
  const limited = computed(() => progress.value?.status === "limited");
  const completed = computed(() => progress.value?.status === "completed");
  const hasTask = computed(() => progress.value !== null);

  /** 是否出现了未解决的跳页记录（断点续传的异常条目）。 */
  const hasSkips = computed(() => (progress.value?.skipped ?? 0) > 0);

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      progress.value = await getArchiveProgress();
      error.value = "";
    } catch (reason) {
      error.value = String(reason);
    } finally {
      refreshing = false;
    }
  }

  /** 幂等：重复调用不会叠加计时器。 */
  function startPolling(intervalMs = 2000) {
    if (timer !== null) return;
    void refresh();
    timer = window.setInterval(() => {
      void refresh();
    }, intervalMs);
  }

  function stopPolling() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  return {
    progress,
    error,
    running,
    limited,
    completed,
    hasTask,
    hasSkips,
    refresh,
    startPolling,
    stopPolling,
  };
});
