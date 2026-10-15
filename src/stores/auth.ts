import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { getQzoneLoginUser, type LoginIdentity, openWebLogin, checkWebLogin, syncCookiesToWebview } from "../utils/qlogin";
import router from "../router";
import { platform } from "../utils/platform";
import { useLicenseStore } from "./license";
import { useRecycleSessionStore } from "./recycle";

/** 仅本 store 内部使用：外部通过 user.value 读取即可，全仓没有 import type 引用，不需要导出。 */
interface LoginUser {
  uin: string;
  nickname: string;
  avatarImage?: string;
}

interface LoginStatus {
  status: "waiting" | "scanned" | "expired" | "success" | "error" | "loggedOut" | "webLoginOpened" | "webLoginWaiting" | "webLoginCancelled";
  message: string;
  auth?: LoginIdentity;
}

interface QrLoginStart {
  qrImage: string;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const useAuthStore = defineStore("auth", () => {
  const dialogVisible = ref(false);
  const loading = ref(false);
  const qrImage = ref("");
  const status = ref<LoginStatus["status"]>("loggedOut");
  const message = ref("使用手机 QQ 扫码登录");
  const user = ref<LoginUser>();
  const webLoginMode = ref(false);
  let pollingRun = 0;
  let restoringSession = false;

  const loggedIn = computed(() => status.value === "success" && Boolean(user.value));

  async function restoreSession() {
    if (restoringSession || loggedIn.value) return;
    restoringSession = true;
    const run = pollingRun;
    try {
      // Restoring an online QQ session is subject to the same license as a new login.
      // Local archive browsing uses independent local-data commands.
      const license = useLicenseStore();
      await license.refresh();
      if (run !== pollingRun) return;
      if (!license.canArchive) {
        status.value = "loggedOut";
        user.value = undefined;
        message.value = "完成软件授权后可登录 QQ 空间";
        return;
      }
      const result = await invoke<LoginStatus>("get_login_status");
      if (run !== pollingRun) return;
      status.value = result.status;
      message.value = result.message;
      if (result.status === "success" && result.auth) {
        // 本地会话已恢复；昵称或头像联网失败不能挡住已有备份。
        user.value = { uin: result.auth.uin, nickname: `QQ ${result.auth.uin}` };
        await loadProfile(run);
        if (run !== pollingRun) return;
        syncCookiesToWebview().catch(() => {});
      }
    } catch {
      if (run === pollingRun) status.value = "loggedOut";
    } finally {
      restoringSession = false;
    }
  }

  async function loadProfile(run: number) {
    try {
      const profile = await getQzoneLoginUser();
      if (run === pollingRun && profile.uin === user.value?.uin) user.value = profile;
    } catch { /* A missing nickname or avatar must not undo a valid login. */ }
  }

  async function ensureLoginAccess() {
    const license = useLicenseStore();
    await license.refresh();
    if (license.canArchive) return true;
    closeLogin();
    await router.push({ path: "/activation", query: { returnTo: router.currentRoute.value.path === "/activation" ? "/" : router.currentRoute.value.fullPath } });
    return false;
  }

  async function openLogin() {
    if (!(await ensureLoginAccess())) return;
    webLoginMode.value = false;
    dialogVisible.value = true;
    if (loggedIn.value) return;
    if (platform() === "android") await startWebLogin();
    else await refreshQrCode();
  }

  async function reauthenticate() {
    // Keep native credentials and the local account directory until the user
    // completes a new login; a dismissed dialog must not delete saved records.
    status.value = "expired";
    message.value = "QQ 登录已失效，请重新登录";
    await openLogin();
  }

  function closeLogin() {
    dialogVisible.value = false;
    // 关闭时一并退出网页登录模式，避免下次打开时界面与真实轮询状态错位。
    webLoginMode.value = false;
    pollingRun += 1;
    void invoke("cancel_web_login").catch(() => {});
  }

  async function refreshQrCode() {
    if (!(await ensureLoginAccess())) return;
    // 扫码与网页登录互斥：一进入扫码流程就退出网页登录模式，保证模板走二维码分支。
    webLoginMode.value = false;
    const run = ++pollingRun;
    loading.value = true;
    qrImage.value = "";
    status.value = "waiting";
    message.value = "正在获取登录二维码…";
    try {
      const result = await invoke<QrLoginStart>("start_qr_login");
      if (run !== pollingRun) return;
      qrImage.value = result.qrImage;
      message.value = "请使用手机 QQ 扫描二维码";
      loading.value = false;
      while (run === pollingRun && dialogVisible.value) {
        await delay(1800);
        if (run !== pollingRun || !dialogVisible.value) return;
        const result = await invoke<LoginStatus>("poll_qr_login");
        if (run !== pollingRun) return;
        status.value = result.status;
        message.value = result.message;
        if (result.status === "success") {
          if (!result.auth) throw new Error("登录响应中缺少 QQ 账号");
          message.value = "正在获取用户资料…";
          user.value = { uin: result.auth.uin, nickname: `QQ ${result.auth.uin}` };
          await loadProfile(run);
          if (run !== pollingRun) return;
          syncCookiesToWebview().catch(() => {});
          await delay(700);
          if (run !== pollingRun) return;
          dialogVisible.value = false;
          pollingRun += 1;
          return;
        }
        if (result.status === "expired" || result.status === "error") return;
      }
    } catch (error) {
      if (run !== pollingRun) return;
      status.value = "error";
      message.value = typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "登录服务暂时不可用";
    } finally {
      if (run === pollingRun) loading.value = false;
    }
  }

  async function startWebLogin() {
    if (!(await ensureLoginAccess())) return;
    dialogVisible.value = true;
    const run = ++pollingRun;
    loading.value = true;
    webLoginMode.value = true;
    qrImage.value = "";
    status.value = "webLoginOpened";
    message.value = "正在打开登录窗口…";
    try {
      const result = await openWebLogin();
      if (run !== pollingRun) return;
      status.value = result.status;
      message.value = result.message;
      loading.value = false;
      while (run === pollingRun && dialogVisible.value && webLoginMode.value) {
        await delay(2000);
        if (run !== pollingRun || !dialogVisible.value || !webLoginMode.value) return;
        const result = await checkWebLogin();
        if (run !== pollingRun) return;
        status.value = result.status;
        message.value = result.message;
        if (result.status === "success") {
          if (!result.auth) throw new Error("登录响应中缺少 QQ 账号");
          user.value = { uin: result.auth.uin, nickname: `QQ ${result.auth.uin}` };
          await loadProfile(run);
          if (run !== pollingRun) return;
          syncCookiesToWebview().catch(() => {});
          await delay(700);
          if (run !== pollingRun) return;
          dialogVisible.value = false;
          webLoginMode.value = false;
          pollingRun += 1;
          return;
        }
        if (result.status === "webLoginCancelled") {
          // 用户在 QQ 登录窗口里取消：退回扫码时必须重新取二维码，否则会停在既无二维码也无按钮的空档。
          if (platform() === "android") {
            message.value = "登录已取消，可以重新打开 QQ 登录页。";
          } else {
            webLoginMode.value = false;
            if (dialogVisible.value) void refreshQrCode();
          }
          return;
        }
        if (result.status === "error") return;
      }
    } catch (error) {
      if (run !== pollingRun) return;
      status.value = "error";
      message.value =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "网页登录服务暂时不可用";
    } finally {
      if (run === pollingRun) loading.value = false;
    }
  }

  function cancelWebLogin() {
    pollingRun += 1;
    webLoginMode.value = false;
    status.value = "loggedOut";
    message.value = "使用手机 QQ 扫码登录";
    loading.value = false;
    void invoke("cancel_web_login").catch(() => {});
    // 回到扫码后必须重新取二维码：否则 qrState 归为 waiting，界面上既没有二维码也没有刷新按钮，用户只能关掉对话框重开。
    if (dialogVisible.value) void refreshQrCode();
  }

  async function logout() {
    pollingRun += 1;
    loading.value = true;
    dialogVisible.value = false;
    try {
      await invoke("logout_qzone");
      useRecycleSessionStore().clear();
      user.value = undefined;
      qrImage.value = "";
      status.value = "loggedOut";
      message.value = "尚未登录";
    } finally {
      loading.value = false;
    }
  }

  return { dialogVisible, loading, qrImage, status, message, user, webLoginMode, loggedIn, restoreSession, openLogin, reauthenticate, closeLogin, refreshQrCode, startWebLogin, cancelWebLogin, logout };
});
