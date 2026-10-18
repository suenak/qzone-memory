import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { computed, onScopeDispose, ref } from "vue";

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
  const seatsError = ref("");
  let disposed = false;
  let revision = 0;
  let commandQueue = Promise.resolve();
  let mutation: Promise<unknown> | undefined;
  let statusRequest: { revision: number; promise: Promise<LicenseView | null> } | undefined;
  let seatsRequest: { revision: number; promise: Promise<LicenseSeat[]> } | undefined;
  let heartbeatRequest: Promise<boolean> | undefined;

  const isCurrent = (run: number) => !disposed && run === revision;
  onScopeDispose(() => { disposed = true; revision += 1; });

  // Heartbeats also write native credentials. Finish them before activation or
  // sign-out so an old server response cannot restore a superseded native token.
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const request = commandQueue.then(operation);
    commandQueue = request.then(() => {}, () => {});
    return request;
  }

  function applyView(result: LicenseView, run: number) {
    if (!isCurrent(run)) return;
    view.value = result;
    lastError.value = result.message ?? "";
    initialized.value = true;
  }

  async function readStatus(run: number) {
    if (!isCurrent(run)) return;
    try {
      applyView(await invoke<LicenseView>("get_license_status"), run);
    } catch (error) {
      if (!isCurrent(run)) return;
      view.value = null;
      lastError.value = String(error);
      initialized.value = true;
    }
  }

  async function readSeats(run: number) {
    if (!isCurrent(run)) return;
    seatsError.value = "";
    try {
      const result = await invoke<LicenseSeat[]>("list_license_seats");
      if (isCurrent(run)) seats.value = result;
    } catch (error) {
      if (!isCurrent(run)) return;
      seats.value = [];
      seatsError.value = String(error);
    }
  }

  function mutate<T>(operation: (run: number) => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new Error("授权操作已结束，请重新打开页面。"));
    if (mutation) return Promise.reject(new Error("授权操作正在进行，请完成后重试。"));
    const run = ++revision;
    loading.value = true;
    lastError.value = "";
    seatsError.value = "";
    const request = enqueue(async () => {
      if (!isCurrent(run)) throw new Error("授权操作已取消。");
      return operation(run);
    }).catch((error) => {
      if (isCurrent(run)) lastError.value = String(error);
      throw error;
    }).finally(() => {
      if (mutation === request) mutation = undefined;
      if (!disposed) loading.value = false;
    });
    mutation = request;
    return request;
  }

  const activated = computed(() => view.value?.activated === true);
  const canArchive = computed(() => !loading.value && view.value?.canArchive === true);
  const status = computed(() => view.value?.status ?? "notActivated");
  const inGrace = computed(() => view.value?.status === "grace");
  const restricted = computed(() => view.value?.status === "restricted");
  const username = computed(() => view.value?.username ?? "");

  function refresh(): Promise<LicenseView | null> {
    if (disposed) return Promise.resolve(view.value);
    if (statusRequest?.revision === revision) return statusRequest.promise;
    const run = revision;
    const promise = enqueue(() => readStatus(run)).then(() => {
      // A read started before an account operation must settle against its final
      // native state, including callers awaiting refresh before logging into QQ.
      if (!disposed && run !== revision) return refresh();
      return view.value;
    }).finally(() => {
      if (statusRequest?.promise === promise) statusRequest = undefined;
    });
    statusRequest = { revision: run, promise };
    return promise;
  }

  function activate(account: string, password: string, deviceLabel: string) {
    return mutate(async (run) => {
      const outcome = await invoke<ActivateOutcome>("activate_license", {
        username: account,
        password,
        deviceLabel: deviceLabel || null,
      });
      applyView(outcome.view, run);
      if (isCurrent(run)) seats.value = outcome.seats;
      return outcome;
    });
  }

  /** 心跳续期。网络失败不算致命：本地宽限期仍然成立，因此不抛异常。 */
  function heartbeat(): Promise<boolean> {
    if (disposed || mutation) return Promise.resolve(false);
    if (heartbeatRequest) return heartbeatRequest;
    const run = revision;
    const request = enqueue(async () => {
      if (!isCurrent(run)) return false;
      try {
        const result = await invoke<LicenseView>("refresh_license");
        if (!isCurrent(run)) return false;
        applyView(result, run);
        return true;
      } catch (error) {
        if (!isCurrent(run)) return false;
        // Native status decides whether an offline grace period remains usable
        // or a revoked token was cleared. Keep local browsing independent of it.
        await readStatus(run);
        if (isCurrent(run) && !lastError.value) lastError.value = String(error);
        return false;
      }
    }).finally(() => {
      if (heartbeatRequest === request) heartbeatRequest = undefined;
    });
    heartbeatRequest = request;
    return request;
  }

  function loadSeats(): Promise<LicenseSeat[]> {
    if (disposed) return Promise.resolve(seats.value);
    if (seatsRequest?.revision === revision) return seatsRequest.promise;
    const run = revision;
    const promise = enqueue(() => readSeats(run)).then(() => {
      if (!disposed && run !== revision) return loadSeats();
      return seats.value;
    }).finally(() => {
      if (seatsRequest?.promise === promise) seatsRequest = undefined;
    });
    seatsRequest = { revision: run, promise };
    return promise;
  }

  /**
   * 解绑设备。
   *
   * 不传账号密码时后端走本机凭证通道（已激活设备无需重复输入）；
   * 在「席位已满、本机尚未激活」的新设备上必须传账号密码。
   */
  function deactivateSeat(seatId: string, account?: string, password?: string) {
    return mutate(async (run) => {
      const result = await invoke<LicenseView>("deactivate_license_seat", {
        seatId,
        username: account ?? null,
        password: password ?? null,
      });
      applyView(result, run);
      await readSeats(run);
    });
  }

  function redeem(account: string, password: string, code: string) {
    return mutate(async (run) => {
      const message = await invoke<string>("redeem_license_code", {
        username: account,
        password,
        code,
      });
      await readStatus(run);
      return message;
    });
  }

  function signOut() {
    return mutate(async (run) => {
      await invoke("sign_out_license");
      if (!isCurrent(run)) return;
      view.value = null;
      seats.value = [];
      await readStatus(run);
    });
  }

  return {
    view,
    seats,
    seatsError,
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
