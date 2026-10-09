import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface LicenseSeat {
  id: string;
  label: string;
  platform: string;
  first_seen: number;
  last_seen: number;
  current: boolean;
}

export interface LicenseView {
  status: "notActivated" | "active" | "grace" | "restricted" | "invalid";
  activated: boolean;
  canArchive: boolean;
  username: string | null;
  /** 账号授权到期日：0 为永久，null 为旧凭证尚未提供。 */
  expiresAt: number | null;
  usableUntil: number | null;
  remainingDays: number | null;
  /** 账号允许的设备席位数，0 表示未知（旧凭证）。 */
  maxSeats: number;
  features: string[];
  installationId: string | null;
  platform: string;
  server: string;
  message: string | null;
}

export interface ActivateOutcome {
  success: boolean;
  message: string;
  code: string | null;
  view: LicenseView;
  user: { id: string; username: string; expires_at: number; max_seats: number; features: string[] } | null;
  seats: LicenseSeat[];
}

/**
 * 授权状态。
 *
 * 客户端侧校验只服务于体验（离线可用、提前提示），不是安全边界——
 * 本项目客户端遵循 GPLv3，任何人都能编译出跳过校验的版本。
 * 真正的边界在服务端：凭证由 Ed25519 私钥签发，且云能力调用会再次校验。
 */
export const useLicenseStore = defineStore("license", () => {
  const view = ref<LicenseView | null>(null);
  const loading = ref(false);
  const initialized = ref(false);
  const lastError = ref("");
  const seats = ref<LicenseSeat[]>([]);

  const activated = computed(() => view.value?.activated === true);
  const canArchive = computed(() => view.value?.canArchive === true);
  const status = computed(() => view.value?.status ?? "notActivated");
  const inGrace = computed(() => view.value?.status === "grace");
  const restricted = computed(() => view.value?.status === "restricted");
  const username = computed(() => view.value?.username ?? "");

  async function refresh() {
    try {
      view.value = await invoke<LicenseView>("get_license_status");
      lastError.value = view.value.message ?? "";
    } catch (error) {
      lastError.value = String(error);
    } finally {
      initialized.value = true;
    }
    return view.value;
  }

  async function activate(account: string, password: string, deviceLabel: string) {
    loading.value = true;
    lastError.value = "";
    try {
      const outcome = await invoke<ActivateOutcome>("activate_license", {
        username: account,
        password,
        deviceLabel: deviceLabel || null,
      });
      view.value = outcome.view;
      seats.value = outcome.seats;
      return outcome;
    } catch (error) {
      lastError.value = String(error);
      throw error;
    } finally {
      loading.value = false;
    }
  }

  /** 心跳续期。网络失败不算致命：本地宽限期仍然成立，因此不抛异常。 */
  async function heartbeat() {
    try {
      view.value = await invoke<LicenseView>("refresh_license");
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = String(error);
      // 被吊销或被停用时后端已清空本地凭证，此处同步刷新界面状态。
      await refresh();
      return false;
    }
  }

  async function loadSeats() {
    lastError.value = "";
    try {
      seats.value = await invoke<LicenseSeat[]>("list_license_seats");
    } catch (error) {
      lastError.value = String(error);
    }
    return seats.value;
  }

  /**
   * 解绑设备。
   *
   * 不传账号密码时后端走本机凭证通道（已激活设备无需重复输入）；
   * 在「席位已满、本机尚未激活」的新设备上必须传账号密码。
   */
  async function deactivateSeat(seatId: string, account?: string, password?: string) {
    loading.value = true;
    try {
      view.value = await invoke<LicenseView>("deactivate_license_seat", {
        seatId,
        username: account ?? null,
        password: password ?? null,
      });
      await loadSeats();
    } finally {
      loading.value = false;
    }
  }

  async function redeem(account: string, password: string, code: string) {
    loading.value = true;
    try {
      const message = await invoke<string>("redeem_license_code", {
        username: account,
        password,
        code,
      });
      await refresh();
      return message;
    } finally {
      loading.value = false;
    }
  }

  async function signOut() {
    await invoke("sign_out_license");
    view.value = null;
    seats.value = [];
    await refresh();
  }

  return {
    view,
    seats,
    loading,
    initialized,
    lastError,
    activated,
    canArchive,
    status,
    inGrace,
    restricted,
    username,
    refresh,
    activate,
    heartbeat,
    loadSeats,
    deactivateSeat,
    redeem,
    signOut,
  };
});
