import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { checkForUpdate, openDownloadPage, downloadUpdate, getUpdateDownloadProgress, cancelUpdateDownload, openUpdatePackage, revealUpdatePackage, type AvailableUpdate, type UpdateDownloadProgress } from "../utils/updater";
import { describeError } from "../utils/uiError";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const AUTO_DOWNLOAD_KEY = "qzone-auto-download-updates";
export const useUpdateStore = defineStore("update", () => {
  const available = ref<AvailableUpdate | null>(null);
  const checking = ref(false);
  const message = ref("");
  const dialogVisible = ref(false);
  const progress = ref<UpdateDownloadProgress | null>(null);
  const actionError = ref("");
  const opening = ref(false);
  const autoDownload = ref(localStorage.getItem(AUTO_DOWNLOAD_KEY) === "true");
  watch(autoDownload, (value) => localStorage.setItem(AUTO_DOWNLOAD_KEY, String(value)));
  const downloading = computed(() => ["preparing", "downloading", "verifying"].includes(progress.value?.status ?? ""));
  const downloaded = computed(() => progress.value?.status === "completed" && progress.value.version === available.value?.version);
  let lastCheck = 0;
  let dismissedVersion = "";
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  let downloadGeneration = 0;
  watch(dialogVisible, (visible) => { if (!visible) dismissedVersion = available.value?.version ?? ""; });

  async function check(options: { silent?: boolean } = {}) {
    if (checking.value) return;
    if (downloading.value) { if (!options.silent) dialogVisible.value = true; return; }
    checking.value = true;
    lastCheck = Date.now();
    if (!options.silent) { message.value = ""; actionError.value = ""; }
    try {
      const found = await checkForUpdate();
      if (found) {
        if (found.version !== available.value?.version) { progress.value = null; actionError.value = ""; }
        available.value = found;
        message.value = downloaded.value ? `v${found.version} 安装包已下载` : `发现新版本 v${found.version}`;
        if (!options.silent || dismissedVersion !== found.version) dialogVisible.value = true;
        if (autoDownload.value && found.download && !downloaded.value && progress.value?.status !== "error" && progress.value?.status !== "cancelled") void download();
      } else {
        available.value = null;
        dialogVisible.value = false;
        if (!options.silent) message.value = "暂未发现可用的新版本。";
      }
    } catch (reason) {
      if (!options.silent) { message.value = describeError(reason, "检查更新失败，请稍后重试。"); actionError.value = message.value; }
    } finally { checking.value = false; }
  }
  async function pollDownload(generation: number) {
    try {
      const snapshot = await getUpdateDownloadProgress();
      if (generation !== downloadGeneration) return;
      if (snapshot.status !== "idle") progress.value = snapshot;
    } catch { /* next poll or command result restores state */ }
    if (generation === downloadGeneration && downloading.value) downloadTimer = setTimeout(() => void pollDownload(generation), 500);
  }
  async function download() {
    if (!available.value?.download || downloading.value || downloaded.value) return;
    actionError.value = "";
    const generation = ++downloadGeneration;
    progress.value = { status: "preparing", version: available.value.version, fileName: available.value.download.fileName, downloaded: 0, total: available.value.download.size, message: "正在确认最新安装包" };
    downloadTimer = setTimeout(() => void pollDownload(generation), 500);
    try {
      progress.value = await downloadUpdate(available.value.version);
      if (progress.value.status === "completed") {
        message.value = `v${progress.value.version} 安装包已下载`;
        dialogVisible.value = true;
      }
    } catch (reason) {
      progress.value = { ...progress.value!, status: "error", message: describeError(reason, "下载失败，请重试。") };
    } finally { ++downloadGeneration; clearTimeout(downloadTimer); }
  }
  async function cancelDownload() {
    try { await cancelUpdateDownload(); } catch (reason) { actionError.value = describeError(reason, "无法取消下载，请稍后重试。"); }
  }
  async function openPackage() {
    opening.value = true;
    actionError.value = "";
    try { await openUpdatePackage(); } catch (reason) {
      actionError.value = describeError(reason, "无法打开安装包，请重试。");
      if (/已被移除|已变更/.test(actionError.value) && progress.value) progress.value.status = "error";
    }
    finally { opening.value = false; }
  }
  async function showPackage() {
    actionError.value = "";
    try { await revealUpdatePackage(); } catch (reason) {
      actionError.value = describeError(reason, "无法打开下载文件夹。");
      if (/已被移除|已变更/.test(actionError.value) && progress.value) progress.value.status = "error";
    }
  }
  async function goToDownloadPage() {
    actionError.value = "";
    try { await openDownloadPage(available.value?.downloadPage); } catch (reason) { actionError.value = describeError(reason, "无法打开下载页，请重试。"); }
  }
  function checkWhenVisible() {
    if (document.visibilityState === "visible" && Date.now() - lastCheck >= CHECK_INTERVAL) void check({ silent: true });
  }
  function startAutomaticChecks() {
    if (checkTimer) return;
    void check({ silent: true });
    checkTimer = setInterval(checkWhenVisible, CHECK_INTERVAL);
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
  }
  function stopAutomaticChecks() {
    clearInterval(checkTimer);
    clearTimeout(downloadTimer);
    checkTimer = undefined;
    window.removeEventListener("focus", checkWhenVisible);
    document.removeEventListener("visibilitychange", checkWhenVisible);
  }
  return { available, checking, message, dialogVisible, progress, downloading, downloaded, actionError, opening, autoDownload, check, download, cancelDownload, openPackage, showPackage, goToDownloadPage, startAutomaticChecks, stopAutomaticChecks };
});
