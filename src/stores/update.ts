import { defineStore } from "pinia";
import { computed, onScopeDispose, ref, watch } from "vue";
import { checkForUpdate, openDownloadPage, downloadUpdate, getUpdateDownloadProgress, cancelUpdateDownload, openUpdatePackage, revealUpdatePackage, type AvailableUpdate, type UpdateDownloadProgress } from "../utils/updater";
import { describeError } from "../utils/uiError";
import { useArchiveStore } from "./archive";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const AUTO_DOWNLOAD_KEY = "qzone-auto-download-updates";
export const useUpdateStore = defineStore("update", () => {
  const archive = useArchiveStore();
  const available = ref<AvailableUpdate | null>(null);
  const checking = ref(false);
  const message = ref("");
  const dialogVisible = ref(false);
  const progress = ref<UpdateDownloadProgress | null>(null);
  const actionError = ref("");
  const opening = ref(false);
  const revealing = ref(false);
  const cancelling = ref(false);
  const downloadPending = ref(false);
  const autoDownload = ref(localStorage.getItem(AUTO_DOWNLOAD_KEY) === "true");
  watch(autoDownload, (value) => localStorage.setItem(AUTO_DOWNLOAD_KEY, String(value)));
  const downloading = computed(() => downloadPending.value || cancelling.value || ["preparing", "downloading", "verifying"].includes(progress.value?.status ?? ""));
  const downloaded = computed(() => !downloading.value && progress.value?.status === "completed" && progress.value.version === available.value?.version);
  let lastCheck = 0;
  let dismissedVersion = "";
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  let downloadGeneration = 0;
  let checkGeneration = 0;
  let disposed = false;
  watch(dialogVisible, (visible) => { if (!visible) dismissedVersion = available.value?.version ?? ""; });

  async function check(options: { silent?: boolean } = {}) {
    if (disposed || checking.value || opening.value || revealing.value) return;
    if (downloading.value) { if (!options.silent) dialogVisible.value = true; return; }
    checking.value = true;
    const generation = checkGeneration;
    let shouldDownload = false;
    lastCheck = Date.now();
    if (!options.silent) { message.value = ""; actionError.value = ""; }
    try {
      const found = await checkForUpdate();
      if (disposed || generation !== checkGeneration) return;
      if (found) {
        if (found.version !== available.value?.version) { progress.value = null; actionError.value = ""; }
        available.value = found;
        message.value = downloaded.value ? `v${found.version} 安装包已下载` : `发现新版本 v${found.version}`;
        if (!options.silent || dismissedVersion !== found.version) dialogVisible.value = true;
        shouldDownload = autoDownload.value && Boolean(found.download) && !downloaded.value && progress.value?.status !== "error" && progress.value?.status !== "cancelled";
      } else {
        available.value = null;
        progress.value = null;
        message.value = "暂未发现可用的新版本。";
        actionError.value = "";
        dialogVisible.value = false;
      }
    } catch (reason) {
      if (!disposed && generation === checkGeneration && !options.silent) { message.value = describeError(reason, "检查更新失败，请稍后重试。"); actionError.value = message.value; }
    } finally { if (!disposed && generation === checkGeneration) checking.value = false; }
    if (!disposed && generation === checkGeneration && shouldDownload) void download();
  }
  async function pollDownload(generation: number) {
    try {
      const snapshot = await getUpdateDownloadProgress();
      if (disposed || generation !== downloadGeneration) return;
      // Only the command result ends this attempt. Native polling can still
      // return the previous attempt before the new download reaches Rust.
      if (snapshot.version === available.value?.version && ["preparing", "downloading", "verifying"].includes(snapshot.status)) progress.value = snapshot;
    } catch { /* next poll or command result restores state */ }
    if (!disposed && generation === downloadGeneration && downloadPending.value) downloadTimer = setTimeout(() => void pollDownload(generation), 500);
  }
  async function download() {
    if (disposed || checking.value || opening.value || revealing.value || !available.value?.download || downloading.value || downloaded.value) return;
    actionError.value = "";
    downloadPending.value = true;
    const generation = ++downloadGeneration;
    progress.value = { status: "preparing", version: available.value.version, fileName: available.value.download.fileName, downloaded: 0, total: available.value.download.size, message: "正在确认最新安装包" };
    downloadTimer = setTimeout(() => void pollDownload(generation), 500);
    try {
      const result = await downloadUpdate(available.value.version);
      if (disposed || generation !== downloadGeneration) return;
      progress.value = result;
      if (progress.value.status === "completed") {
        message.value = `v${progress.value.version} 安装包已下载`;
        dialogVisible.value = true;
      }
    } catch (reason) {
      if (!disposed && generation === downloadGeneration) progress.value = { ...progress.value!, status: "error", message: describeError(reason, "下载失败，请重试。") };
    } finally {
      if (!disposed && generation === downloadGeneration) {
        ++downloadGeneration;
        downloadPending.value = false;
        clearTimeout(downloadTimer);
      }
    }
  }
  async function cancelDownload() {
    if (disposed || cancelling.value || !downloading.value) return;
    const generation = downloadGeneration;
    cancelling.value = true;
    actionError.value = "";
    try { await cancelUpdateDownload(); }
    catch (reason) { if (!disposed && generation === downloadGeneration) actionError.value = describeError(reason, "无法取消下载，请稍后重试。"); }
    finally { if (!disposed) cancelling.value = false; }
  }
  function packageFailed(reason: unknown, fallback: string) {
    if (disposed) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    if (/安装包已(?:被移除|变更|不可用)/.test(message) && progress.value) {
      actionError.value = "安装包已不可用，请重新下载。";
      progress.value = { ...progress.value, status: "error", message: actionError.value };
    } else actionError.value = describeError(reason, fallback);
  }
  async function openPackage() {
    if (disposed || checking.value || opening.value || revealing.value || !downloaded.value || archive.busy) return;
    opening.value = true;
    actionError.value = "";
    try { await openUpdatePackage(); } catch (reason) {
      packageFailed(reason, "无法打开安装包，请重试。");
    }
    finally { if (!disposed) opening.value = false; }
  }
  async function showPackage() {
    if (disposed || checking.value || opening.value || revealing.value || !downloaded.value) return;
    revealing.value = true;
    actionError.value = "";
    try { await revealUpdatePackage(); } catch (reason) {
      packageFailed(reason, "无法打开下载文件夹。");
    }
    finally { if (!disposed) revealing.value = false; }
  }
  async function goToDownloadPage() {
    if (disposed) return;
    actionError.value = "";
    try { await openDownloadPage(available.value?.downloadPage); } catch (reason) { if (!disposed) actionError.value = describeError(reason, "无法打开下载页，请重试。"); }
  }
  function checkWhenVisible() {
    if (document.visibilityState === "visible" && Date.now() - lastCheck >= CHECK_INTERVAL) void check({ silent: true });
  }
  function startAutomaticChecks() {
    if (disposed || checkTimer !== undefined) return;
    void check({ silent: true });
    checkTimer = setInterval(checkWhenVisible, CHECK_INTERVAL);
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
  }
  function stopAutomaticChecks() {
    ++checkGeneration;
    checking.value = false;
    clearInterval(checkTimer);
    checkTimer = undefined;
    window.removeEventListener("focus", checkWhenVisible);
    document.removeEventListener("visibilitychange", checkWhenVisible);
  }
  onScopeDispose(() => {
    disposed = true;
    ++downloadGeneration;
    stopAutomaticChecks();
    clearTimeout(downloadTimer);
  });
  return { available, checking, message, dialogVisible, progress, downloading, downloaded, actionError, opening, revealing, cancelling, autoDownload, check, download, cancelDownload, openPackage, showPackage, goToDownloadPage, startAutomaticChecks, stopAutomaticChecks };
});
