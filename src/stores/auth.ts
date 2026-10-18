import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { computed, onScopeDispose, ref } from "vue";
import { qqSession, requiresQqLogin } from "../utils/qqSession";
import { getQzoneLoginUser, type LoginIdentity, openWebLogin, checkWebLogin, syncCookiesToWebview } from "../utils/qlogin";
import router from "../router";
import { platform } from "../utils/platform";
import { useLicenseStore } from "./license";
import { useRecycleSessionStore } from "./recycle";
import { useArchiveStore } from "./archive";

/** 仅本 store 内部使用：外部通过 user.value 读取即可，全仓没有 import type 引用，不需要导出。 */
interface LoginUser {
  uin: string;
  nickname: string;
  avatarImage?: string;
}

interface LoginStatus {
  status: "restored" | "checking" | "unverified" | "waiting" | "scanned" | "expired" | "success" | "error" | "loggedOut" | "webLoginOpened" | "webLoginWaiting" | "webLoginCancelled";
  message: string;
  auth?: LoginIdentity;
}

interface QrLoginStart {
  qrImage: string;
}

export const useAuthStore = defineStore("auth", () => {
  const dialogVisible = ref(false);
  const loading = ref(false);
  const qrImage = ref("");
  const status = ref<LoginStatus["status"]>("loggedOut");
  const message = ref("使用手机 QQ 扫码登录");
  const user = ref<LoginUser>();
  const webLoginMode = ref(false);
  let pollingRun = 0;
  let restoringRun: number | undefined;
  let lastSessionCheck = 0;
  let disposed = false;
  let cancelDelay: (() => void) | undefined;
  let logoutRequest: Promise<void> | undefined;
  let webCancellation = Promise.resolve();

  function nextRun() {
    pollingRun += 1;
    cancelDelay?.();
    return pollingRun;
  }

  const isCurrent = (run: number) => !disposed && run === pollingRun;

  function accountChangeBlocked() {
    const archive = useArchiveStore();
    if (archive.recoveringRecycle) { message.value = "回收站恢复正在进行，请完成后再登录。"; return true; }
    if (archive.dataChanging) { message.value = "本地数据正在整理，请完成后再登录。"; return true; }
    return false;
  }

  function delay(milliseconds: number) {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (cancelDelay === finish) cancelDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      cancelDelay = finish;
    });
  }

  function cancelNativeLogin() {
    // A delayed cancellation must finish before a newer login starts polling.
    webCancellation = webCancellation.then(() => invoke<void>("cancel_web_login")).catch(() => {});
  }

  const loggedIn = computed(() => status.value === "success" && Boolean(user.value));
  const accountLabel = computed(() => status.value === "checking" ? "正在确认登录"
    : status.value === "unverified" ? "登录状态待确认"
    : status.value === "expired" ? "QQ 登录已失效" : user.value?.nickname || "尚未登录");

  function expireSession() {
    nextRun();
    user.value = undefined;
    qrImage.value = "";
    loading.value = Boolean(logoutRequest);
    webLoginMode.value = false;
    status.value = "expired";
    message.value = "QQ 登录已失效，请重新登录";
    useRecycleSessionStore().clear();
  }
  const stopExpired = qqSession.onExpired(expireSession);
  onScopeDispose(() => {
    disposed = true;
    nextRun();
    stopExpired();
  });

  async function restoreSession(force = false) {
    if (disposed || logoutRequest || loading.value || restoringRun === pollingRun || dialogVisible.value || qqSession.expired || useArchiveStore().dataChanging || useArchiveStore().recoveringRecycle) return;
    if (!force && Date.now() - lastSessionCheck < 60_000) return;
    lastSessionCheck = Date.now();
    const run = pollingRun;
    restoringRun = run;
    status.value = "checking";
    message.value = "正在确认 QQ 登录状态…";
    try {
      // Restoring an online QQ session is subject to the same license as a new login.
      // Local archive browsing uses independent local-data commands.
      const license = useLicenseStore();
      await license.refresh();
      if (!isCurrent(run)) return;
      if (!license.canArchive) {
        status.value = "loggedOut";
        user.value = undefined;
        message.value = "完成软件授权后可登录 QQ 空间";
        return;
      }
      const result = await invoke<LoginStatus>("get_login_status");
      if (!isCurrent(run)) return;
      if ((result.status === "restored" || result.status === "success") && result.auth) {
        // Reading the vault is not proof of an online login. Confirm with QQ first.
        const profile = await getQzoneLoginUser();
        if (!isCurrent(run)) return;
        if (profile.uin !== result.auth.uin) throw new Error("QQ_LOGIN_REQUIRED: QQ 账号已变化，请重新登录");
        user.value = profile;
        status.value = "success";
        message.value = "QQ 已登录";
        syncCookiesToWebview().catch(() => {});
      } else {
        user.value = undefined;
        status.value = result.status === "expired" ? "expired" : "loggedOut";
        message.value = result.message;
      }
    } catch (error) {
      if (!isCurrent(run)) return;
      if (requiresQqLogin(error)) { qqSession.expire(); return; }
      user.value = undefined;
      status.value = "unverified";
      message.value = "暂时无法确认 QQ 登录状态，可稍后重试或重新登录。本地记录仍可查看。";
    } finally {
      if (restoringRun === run) restoringRun = undefined;
    }
  }

  async function loadProfile(run: number) {
    try {
      const profile = await getQzoneLoginUser();
      if (isCurrent(run) && profile.uin === user.value?.uin) user.value = profile;
    } catch { /* A missing nickname or avatar must not undo a valid login. */ }
  }

  async function ensureLoginAccess(run: number) {
    if (accountChangeBlocked()) return false;
    const license = useLicenseStore();
    await license.refresh();
    if (!isCurrent(run)) return false;
    if (accountChangeBlocked()) return false;
    if (license.canArchive) return true;
    closeLogin();
    await router.push({ path: "/activation", query: { returnTo: router.currentRoute.value.path === "/activation" ? "/" : router.currentRoute.value.fullPath } });
    return false;
  }

  async function requestLogin(mode: "open" | "qr" | "web") {
    if (disposed || logoutRequest) return;
    if (accountChangeBlocked()) return;
    // Own the request before checking the licence: close/logout and newer attempts
    // must also invalidate responses from that asynchronous check.
    const run = nextRun();
    loading.value = true;
    try {
      if (!(await ensureLoginAccess(run))) return;
      await webCancellation;
      if (!isCurrent(run)) return;
      if (accountChangeBlocked()) return;
      dialogVisible.value = true;
      if (mode === "open" && loggedIn.value) { webLoginMode.value = false; return; }
      qqSession.beginLogin();
      if (mode === "web" || (mode === "open" && platform() === "android")) await runWebLogin(run);
      else await runQrLogin(run);
    } catch (error) {
      if (!isCurrent(run)) return;
      status.value = "error";
      message.value = typeof error === "string" ? error : error instanceof Error ? error.message : "登录服务暂时不可用";
    } finally {
      if (isCurrent(run)) loading.value = false;
    }
  }

  function openLogin() {
    return requestLogin("open");
  }

  async function reauthenticate() {
    if (disposed || logoutRequest) return;
    if (accountChangeBlocked()) return;
    // Keep native credentials and the local account directory until the user
    // completes a new login; a dismissed dialog must not delete saved records.
    qqSession.expire();
    await openLogin();
  }

  function closeLogin() {
    if (disposed) return;
    dialogVisible.value = false;
    // 关闭时一并退出网页登录模式，避免下次打开时界面与真实轮询状态错位。
    webLoginMode.value = false;
    nextRun();
    loading.value = Boolean(logoutRequest);
    cancelNativeLogin();
  }

  function refreshQrCode() {
    return requestLogin("qr");
  }

  async function runQrLogin(run: number) {
    // 扫码与网页登录互斥：一进入扫码流程就退出网页登录模式，保证模板走二维码分支。
    webLoginMode.value = false;
    loading.value = true;
    qrImage.value = "";
    status.value = "waiting";
    message.value = "正在获取登录二维码…";
    try {
      const result = await invoke<QrLoginStart>("start_qr_login");
      if (!isCurrent(run)) return;
      qrImage.value = result.qrImage;
      message.value = "请使用手机 QQ 扫描二维码";
      loading.value = false;
      while (isCurrent(run) && dialogVisible.value) {
        await delay(1800);
        if (!isCurrent(run) || !dialogVisible.value) return;
        const result = await invoke<LoginStatus>("poll_qr_login");
        if (!isCurrent(run)) return;
        status.value = result.status;
        message.value = result.message;
        if (result.status === "success") {
          if (!result.auth) throw new Error("登录响应中缺少 QQ 账号");
          qqSession.authenticated();
          lastSessionCheck = Date.now();
          message.value = "正在获取用户资料…";
          user.value = { uin: result.auth.uin, nickname: `QQ ${result.auth.uin}` };
          await loadProfile(run);
          if (!isCurrent(run)) return;
          syncCookiesToWebview().catch(() => {});
          await delay(700);
          if (!isCurrent(run)) return;
          dialogVisible.value = false;
          nextRun();
          return;
        }
        if (result.status === "expired" || result.status === "error") return;
      }
    } catch (error) {
      if (!isCurrent(run)) return;
      status.value = "error";
      message.value = typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "登录服务暂时不可用";
    } finally {
      if (isCurrent(run)) loading.value = false;
    }
  }

  function startWebLogin() {
    return requestLogin("web");
  }

  async function runWebLogin(run: number) {
    loading.value = true;
    webLoginMode.value = true;
    qrImage.value = "";
    status.value = "webLoginOpened";
    message.value = "正在打开登录窗口…";
    try {
      const result = await openWebLogin();
      if (!isCurrent(run)) return;
      status.value = result.status;
      message.value = result.message;
      loading.value = false;
      while (isCurrent(run) && dialogVisible.value && webLoginMode.value) {
        await delay(2000);
        if (!isCurrent(run) || !dialogVisible.value || !webLoginMode.value) return;
        const result = await checkWebLogin();
        if (!isCurrent(run)) return;
        status.value = result.status;
        message.value = result.message;
        if (result.status === "success") {
          if (!result.auth) throw new Error("登录响应中缺少 QQ 账号");
          qqSession.authenticated();
          lastSessionCheck = Date.now();
          user.value = { uin: result.auth.uin, nickname: `QQ ${result.auth.uin}` };
          await loadProfile(run);
          if (!isCurrent(run)) return;
          syncCookiesToWebview().catch(() => {});
          await delay(700);
          if (!isCurrent(run)) return;
          dialogVisible.value = false;
          webLoginMode.value = false;
          nextRun();
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
      if (!isCurrent(run)) return;
      status.value = "error";
      message.value =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "网页登录服务暂时不可用";
    } finally {
      if (isCurrent(run)) loading.value = false;
    }
  }

  function cancelWebLogin() {
    if (disposed || logoutRequest) return;
    nextRun();
    webLoginMode.value = false;
    status.value = "loggedOut";
    message.value = "使用手机 QQ 扫码登录";
    loading.value = false;
    cancelNativeLogin();
    // 回到扫码后必须重新取二维码：否则 qrState 归为 waiting，界面上既没有二维码也没有刷新按钮，用户只能关掉对话框重开。
    if (dialogVisible.value) void refreshQrCode();
  }

  function logout(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (logoutRequest) return logoutRequest;
    if (useArchiveStore().recoveringRecycle) return Promise.reject(new Error("回收站恢复正在进行，请完成后再退出登录。"));
    nextRun();
    // Invalidate old QQ requests without clearing a known expiry until native
    // logout succeeds. A failed logout may already have partially cleared cookies.
    qqSession.beginLogin();
    loading.value = true;
    dialogVisible.value = false;
    webLoginMode.value = false;
    user.value = undefined;
    qrImage.value = "";
    status.value = qqSession.expired ? "expired" : "unverified";
    message.value = "正在退出 QQ 登录…";
    lastSessionCheck = 0;
    logoutRequest = Promise.resolve().then(() => invoke("logout_qzone")).then(() => {
      if (disposed) return;
      qqSession.loggedOut();
      useRecycleSessionStore().clear();
      user.value = undefined;
      qrImage.value = "";
      status.value = "loggedOut";
      message.value = "尚未登录";
    }).catch((error) => {
      if (!disposed) message.value = "退出登录未完成，请重试或重新确认 QQ 登录状态。本地记录仍可查看。";
      throw error;
    }).finally(() => {
      logoutRequest = undefined;
      if (!disposed) loading.value = false;
    });
    return logoutRequest;
  }

  return { dialogVisible, loading, qrImage, status, message, user, webLoginMode, loggedIn, accountLabel, restoreSession, openLogin, reauthenticate, closeLogin, refreshQrCode, startWebLogin, cancelWebLogin, logout };
});
