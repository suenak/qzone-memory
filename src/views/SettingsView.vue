<script setup lang="ts">
import { describeError, describeLicenseError } from "../utils/uiError";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getVersion } from "@tauri-apps/api/app";
import {
  Settings,
  Plus,
  Minus,
  Database,
  Info,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
  User,
} from "lucide-vue-next";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import SectionCard from "../components/ui/SectionCard.vue";
import ArchiveHeading from "../components/ui/ArchiveHeading.vue";
import { useToast } from "../composables/useToast";
import { useAppStore, type Density, type ThemeMode } from "../stores/app";
import { useAuthStore } from "../stores/auth";
import { useLicenseStore, type LicenseSeat } from "../stores/license";
import { useArchiveStore } from "../stores/archive";
import {
  MIN_ARCHIVE_INTERVAL,
  MAX_ARCHIVE_INTERVAL,
  getArchiveInterval,
  setArchiveInterval,
} from "../utils/appSettings";
import { listLocalAccounts, selectLocalAccount, clearArchivedFeeds, deleteAllAppData } from "../utils/qzone";
import { useUpdateStore } from "../stores/update";

const appStore = useAppStore();
const authStore = useAuthStore();
const licenseStore = useLicenseStore();
const router = useRouter();
const toast = useToast();
const archiveStore = useArchiveStore();
const loggingOut = ref(false);

const { loggedIn, user } = storeToRefs(authStore);
const { themeMode, density } = storeToRefs(appStore);

const intervalMs = ref(getArchiveInterval());
/** 输入框草稿：与持久值分离，避免逐键输入时被归一化改写。 */
const intervalInputSeconds = ref(intervalMs.value / 1000);
const privacyVisible = ref(false);
const deleteVisible = ref(false);
const clearVisible = ref(false);
const deleting = ref(false);
const clearing = ref(false);
const error = ref("");
const appVersion = ref("");

/* ------------------------------------------------------------------ 更新 */

/* 状态与弹窗都在 update store 里：启动时的静默检查发生在设置页之外，
   两边必须共用同一份状态，否则会出现「启动已经发现新版、进设置页却显示已是最新」。 */
const updateStore = useUpdateStore();

/* 与 TasksView 同源问题：输入框一旦直接绑到带 clamp 的 setter，用户想输 10000ms 时，
 * 第一个 "1" 就被改成 2000，继续输入得到 20000 而不是 10000。这里只保留草稿，
 * blur / 回车时才归一化并保存。 */
function commitIntervalInput() {
  const seconds = typeof intervalInputSeconds.value === "number" && Number.isFinite(intervalInputSeconds.value)
    ? intervalInputSeconds.value
    : intervalMs.value / 1000;
  const normalized = setArchiveInterval(seconds * 1000);
  intervalMs.value = normalized;
  intervalInputSeconds.value = normalized / 1000;
}

onMounted(async () => {
  try {
    appVersion.value = await getVersion();
  } catch (reason) {
    console.warn("读取应用版本失败", reason);
  }
});

/* ------------------------------------------------------------------ 外观 */

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "浅色", icon: Sun },
  { mode: "dark", label: "深色", icon: Moon },
  { mode: "system", label: "跟随系统", icon: Monitor },
];

const DENSITY_OPTIONS: { value: Density; label: string; hint: string }[] = [
  { value: "comfortable", label: "舒适", hint: "默认留白" },
  { value: "compact", label: "紧凑", hint: "一屏更多内容" },
];

/* ------------------------------------------------------------------ 账号 */

const licenseSummary = computed(() => {
  const view = licenseStore.view;
  if (!view?.activated) return "本设备尚未激活";
  const expiry = view.expiresAt === null
    ? "联网后更新授权到期日"
    : view.expiresAt === 0 ? "永久有效" : `${formatDate(view.expiresAt)} 到期`;
  const statusText = licenseStore.restricted
    ? "已超出宽限期，仅可查看与导出"
    : licenseStore.inGrace
      ? "暂时离线可用"
      : "已激活";
  return `${view.username || "已激活"} · ${statusText} · ${expiry}`;
});

function formatDate(seconds: number | null) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("zh-CN");
}

/* -------------------------------------------------------------- 数据管理 */

async function clearArchiveContent() {
  if (clearing.value || archiveStore.busy) return;
  clearing.value = true;
  error.value = "";
  try {
    const removed = await clearArchivedFeeds();
    clearVisible.value = false;
    toast.success(`已清空 ${removed} 条备份记录，账号与授权保留`);
  } catch (reason) {
    error.value = String(reason);
    toast.error("清空失败，请稍后重试");
  } finally {
    clearing.value = false;
  }
}

const localAccounts = ref<{uin: string; selected: boolean}[]>([]);
const localAccount = ref("");
const switchingLocal = ref(false);
onMounted(async () => {
  try { localAccounts.value = await listLocalAccounts(); localAccount.value = localAccounts.value.find(a => a.selected)?.uin || ""; } catch { /* Retry after opening settings again. */ }
});
async function switchLocalAccount() {
  if (!localAccount.value || switchingLocal.value) return;
  switchingLocal.value = true;
  try { await selectLocalAccount(localAccount.value); localAccounts.value.forEach(a => a.selected = a.uin === localAccount.value); toast.success("已切换本地账号"); }
  catch (reason) { toast.error(describeError(reason,"账号没有切换成功，请重试。")); localAccount.value = localAccounts.value.find(a => a.selected)?.uin || ""; }
  finally { switchingLocal.value = false; }
}

async function deleteEverything() {
  if (deleting.value || archiveStore.busy) return;
  deleting.value = true;
  error.value = "";
  try {
    await deleteAllAppData();
  } catch (reason) {
    // 只有主体删除失败才算失败：此时数据未删净，用户可以按提示重试。
    error.value = String(reason);
    toast.error("删除失败，请稍后重试");
    deleting.value = false;
    return;
  }
  /* 主体已经删净（后端已清理当前账号数据库、媒体文件与 QQ 会话），后续三步都只是收尾：
   * 它们各自兜错并降级为提示，否则会把「其实删成功」报成失败，用户再点一次就会
   * 在空库上重复执行删除路径。 */
  deleteVisible.value = false;
  toast.success("当前账号数据已删除");
  deleting.value = false;

  try { await authStore.logout(); }
  catch (reason) { toast.error(describeError(reason, "数据已删除，但退出 QQ 登录未完成，请手动退出。")); }
  try { await licenseStore.refresh(); }
  catch (reason) { toast.error(describeError(reason, "数据已删除，但授权状态刷新失败，可稍后重试。")); }
}

/* ------------------------------------------------------------ 授权席位 */

const seatsVisible = ref(false);
const seatsBusy = ref(false);
const seatMessage = ref("");
const seatError = ref("");
const accountConfirmVisible = ref(false);
const releaseTarget = ref<LicenseSeat | null>(null);
const accountAction = ref<"release" | "signOut">("release");
const confirmError = ref("");
const accountActionBusy = ref(false);
function askRelease(seat: LicenseSeat) { releaseTarget.value = seat; accountAction.value = "release"; confirmError.value = ""; accountConfirmVisible.value = true; }
function askSignOut() { accountAction.value = "signOut"; confirmError.value = ""; accountConfirmVisible.value = true; }
async function confirmAccountAction() {
  if (accountActionBusy.value) return;
  accountActionBusy.value = true;
  confirmError.value = "";
  try {
    if (accountAction.value === "release" && releaseTarget.value) {
      await licenseStore.deactivateSeat(releaseTarget.value.id);
      seatMessage.value = "设备已解绑，名额已释放。";
      seatError.value = licenseStore.lastError ? describeLicenseError(licenseStore.lastError, "解绑成功，但设备列表未能刷新。") : "";
    } else {
      await licenseStore.signOut();
      seatsVisible.value = false;
      toast.success("已退出授权，重新使用时需激活。");
    }
    accountConfirmVisible.value = false;
  } catch (reason) { confirmError.value = describeLicenseError(reason); }
  finally { accountActionBusy.value = false; }
}
async function logout() {
  if (loggingOut.value || archiveStore.busy) return;
  loggingOut.value = true;
  try { await authStore.logout(); toast.success("已退出 QQ 登录。"); }
  catch (reason) { toast.error(describeError(reason, "退出登录失败，请重试。")); }
  finally { loggingOut.value = false; }
}

async function openSeats() {
  seatsBusy.value = true;
  seatMessage.value = "";
  seatError.value = "";
  seatsVisible.value = true;
  try {
    await licenseStore.loadSeats();
    if (licenseStore.lastError) seatError.value = describeLicenseError(licenseStore.lastError, "设备列表读取失败，请重试。");
  } finally {
    seatsBusy.value = false;
  }
}

async function refreshSeats() {
  seatsBusy.value = true;
  seatMessage.value = "";
  try {
    await licenseStore.loadSeats();
    seatError.value = licenseStore.lastError ? describeLicenseError(licenseStore.lastError, "设备列表读取失败，请重试。") : "";
    if (!seatError.value) seatMessage.value = "设备列表已刷新。";
  } catch (reason) {
    seatError.value = describeLicenseError(reason);
  } finally {
    seatsBusy.value = false;
  }
}

</script>

<template>
  <div class="settings-stack">
    <ArchiveHeading title="设置" description="调整外观，管理账号、设备和本地数据。" :icon="Settings" />
    <!-- ------------------------------------------------------------ 外观 -->
    <SectionCard title="外观" description="主题与界面密度会立即生效，并记住你的选择">
      <div class="setting-row">
        <div class="setting-row__label">
          <strong>主题</strong>
          <small>跟随系统的浅色或深色设置</small>
        </div>
        <div class="segmented" role="group" aria-label="主题">
          <button
            v-for="option in THEME_OPTIONS"
            :key="option.mode"
            type="button"
            class="segmented__item"
            :class="{ 'is-active': themeMode === option.mode }"
            :aria-pressed="themeMode === option.mode"
            @click="appStore.setTheme(option.mode)"
          >
            <component :is="option.icon" :size="15" :stroke-width="1.8" />
            <span>{{ option.label }}</span>
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-row__label">
          <strong>界面密度</strong>
          <small>{{ DENSITY_OPTIONS.find((item) => item.value === density)?.hint }}</small>
        </div>
        <div class="segmented" role="group" aria-label="界面密度">
          <button
            v-for="option in DENSITY_OPTIONS"
            :key="option.value"
            type="button"
            class="segmented__item"
            :class="{ 'is-active': density === option.value }"
            :aria-pressed="density === option.value"
            @click="appStore.setDensity(option.value)"
          >
            <span>{{ option.label }}</span>
          </button>
        </div>
      </div>
    </SectionCard>

    <!-- ------------------------------------------------------------ 账号 -->
    <SectionCard title="账号" description="QQ 空间登录状态与软件授权">
      <div class="setting-row">
        <div class="setting-row__label">
          <span class="setting-row__icon"><User :size="17" :stroke-width="1.8" /></span>
          <div>
            <strong>QQ 空间账号</strong>
            <small>{{ loggedIn ? `${user?.nickname || user?.uin}（QQ ${user?.uin}）` : authStore.message }}</small>
          </div>
        </div>
        <Button
          v-if="loggedIn"
          label="退出登录"
          severity="danger"
          outlined
          size="small"
          :loading="loggingOut"
          :disabled="archiveStore.busy"
          :title="archiveStore.busy ? '请先停止备份或资料同步，再退出登录' : undefined"
          @click="logout"
        />
        <Button v-else label="登录" size="small" @click="authStore.openLogin" />
      </div>

      <div class="setting-row">
        <div class="setting-row__label">
          <span class="setting-row__icon"><ShieldCheck :size="17" :stroke-width="1.8" /></span>
          <div>
            <strong>软件授权</strong>
            <small>{{ licenseSummary }}</small>
          </div>
        </div>
        <Button
          :label="licenseStore.activated ? '管理设备' : '激活本设备'"
          severity="secondary"
          outlined
          size="small"
          :loading="seatsBusy"
          @click="licenseStore.activated ? openSeats() : router.push('/activation')"
        />
      </div>
    </SectionCard>

    <!-- ------------------------------------------------------ 备份与数据 -->
    <SectionCard title="备份与数据" description="调整读取间隔，或清理本地备份">
      <div class="setting-row">
        <div class="setting-row__label">
          <span class="setting-row__icon"><RefreshCw :size="17" :stroke-width="1.8" /></span>
          <div>
            <strong>每页读取间隔</strong>
            <small>每页读取后的等待时间。间隔较长可减少频繁请求。</small>
          </div>
        </div>
        <div class="interval-control">
          <InputNumber
            v-model="intervalInputSeconds"
            aria-label="每页读取间隔（秒）"
            :min="MIN_ARCHIVE_INTERVAL / 1000"
            :max="MAX_ARCHIVE_INTERVAL / 1000"
            :step="0.5"
            :max-fraction-digits="1"
            :disabled="archiveStore.busy"
            suffix=" 秒"
            show-buttons
            button-layout="horizontal"
            @blur="commitIntervalInput"
            @keydown.enter="commitIntervalInput"
          ><template #incrementicon><Plus :size="15" :stroke-width="1.8" /></template><template #decrementicon><Minus :size="15" :stroke-width="1.8" /></template></InputNumber>
          <small>{{ archiveStore.busy ? '停止备份或同步后可调整' : '建议 3–5 秒，下次备份生效' }}</small>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-row__label">
          <span class="setting-row__icon"><Database :size="17" :stroke-width="1.8" /></span>
          <div>
            <strong>清空当前账号的说说</strong>
            <small>清空当前 QQ 账号的说说、互动和续传记录。保留相册等其他资料、媒体缓存与授权。</small>
          </div>
        </div>
        <Button label="清空说说" severity="secondary" outlined size="small" :disabled="!loggedIn || archiveStore.busy" @click="error = ''; clearVisible = true" />
      </div>

      <div v-if="localAccounts.length > 1" class="setting-row">
        <div class="setting-row__label"><div><strong>查看本机其他账号</strong><small>{{ loggedIn ? '退出 QQ 登录后，可切换已保存的账号。' : '切换后可离线查看、搜索和导出这个账号的记录。' }}</small></div></div>
        <Select v-model="localAccount" :options="localAccounts.map(a => ({label: `QQ ${a.uin}`, value: a.uin}))" option-label="label" option-value="value" :disabled="loggedIn || switchingLocal || archiveStore.busy" aria-label="本地账号" @change="switchLocalAccount" />
      </div>
      <div class="setting-row is-danger">
        <div class="setting-row__label">
          <span class="setting-row__icon is-danger"><Trash2 :size="17" :stroke-width="1.8" /></span>
          <div>
            <strong>删除当前账号数据</strong>
            <small>删除当前账号的备份、续传记录、媒体文件和 QQ 登录状态。保留其他账号与软件授权。</small>
          </div>
        </div>
        <Button label="删除当前账号数据" severity="danger" outlined size="small" :disabled="archiveStore.busy" @click="error = ''; deleteVisible = true" />
      </div>

      <p v-if="error" class="settings-error" role="alert">{{ describeError(error) }}</p>
    </SectionCard>

    <!-- ------------------------------------------------------------ 关于 -->
    <SectionCard title="关于">
      <div class="about">
        <div class="about__head">
          <span class="about__mark" aria-hidden="true">忆</span>
          <div>
            <strong>拾忆</strong>
            <span>跨平台 QQ 空间恢复备份工具</span>
          </div>
          <span class="about__version">{{ appVersion ? `v${appVersion}` : "版本未知" }}</span>
        </div>

        <dl class="about__meta">
          <div>
            <dt>授权状态</dt>
            <dd>{{ licenseSummary }}</dd>
          </div>
          <div>
            <dt>设备标识</dt>
            <dd class="about__mono">{{ licenseStore.view?.installationId ?? "初始化中" }}</dd>
          </div>
          <div>
            <dt>数据存储</dt>
            <dd>本机应用数据目录</dd>
          </div>
        </dl>

        <div class="about__update">
          <div class="about__update-text">
            <strong>应用更新</strong>
            <small>{{ updateStore.message || `当前版本 v${appVersion || "未知"}` }}</small>
          </div>
          <Button
            :label="updateStore.checking ? '检查中…' : updateStore.downloading || updateStore.downloaded ? '查看下载' : '检查更新'"
            severity="secondary"
            outlined
            size="small"
            :loading="updateStore.checking"
            @click="updateStore.downloading || updateStore.downloaded ? updateStore.dialogVisible = true : updateStore.check()"
          />
        </div>

        <div class="about__update">
          <div class="about__update-text"><strong>自动下载安装包</strong><small>启动和运行期间会自动检查；开启后，有新版就后台下载，安装由你确认。</small></div>
          <Checkbox v-model="updateStore.autoDownload" binary aria-label="自动下载安装包" />
        </div>

        <p class="about__notice">
          本软件为非官方工具。备份内容保存在本机，不会上传至开发者服务器。
        </p>

        <button class="about__privacy" type="button" @click="privacyVisible = true">
          <Info :size="15" :stroke-width="1.8" />
          <span>查看隐私协议与数据处理说明</span>
        </button>
      </div>
    </SectionCard>

    <!-- ------------------------------------------------------------ 弹窗 -->
    <Dialog v-model:visible="privacyVisible" modal :draggable="false" header="隐私协议" class="settings-dialog">
      <div class="prose">
        <p>备份内容保存在本机。以下说明哪些信息会被保存或发送。</p>
        <h4>1. 数据存储</h4>
        <p>QQ 空间动态、留言、点赞、评论、登录会话和媒体缓存保存在你的设备本地，不会上传至本项目的开发者服务器。</p>
        <h4>2. 网络请求</h4>
        <p>登录、备份和下载媒体会连接腾讯相关服务；激活与授权更新会连接授权服务，发送授权账号和设备信息。</p>
        <h4>3. 登录凭证</h4>
        <p>扫码登录产生的 Cookie 仅保存在操作系统凭据库，用于访问当前账号有权查看的 QQ 空间内容。退出登录或删除当前账号数据后，本地会话会被清除。</p>
        <h4>4. 导出与分享</h4>
        <p>导出的 HTML 和保存的图片由你自行保管。文件可能包含昵称、QQ 号、头像和空间内容，请谨慎分享。</p>
        <h4>5. 数据删除</h4>
        <p>你可以随时使用「删除当前账号数据」清理当前账号的本地备份、任务续传位置、视频缓存与登录状态，此操作无法撤销。</p>
      </div>
      <template #footer>
        <Button label="我已了解" @click="privacyVisible = false" />
      </template>
    </Dialog>

    <Dialog v-model:visible="clearVisible" modal :draggable="false" :closable="!clearing" :close-on-escape="!clearing" header="清空当前账号的说说备份？" class="settings-dialog">
      <div class="confirm">
        <span class="confirm__icon"><Database :size="20" :stroke-width="1.8" /></span>
        <div>
          <p>当前 QQ 账号的说说、评论、点赞和续传记录将被删除。</p>
          <small>相册等其他资料、媒体缓存、登录状态和授权会保留。删除无法撤销，重新备份也不保证能找回全部内容。</small>
        </div>
      </div>
      <p v-if="error" role="alert" class="settings-error">{{ describeError(error, '清空失败，请重试。') }}</p>
      <template #footer>
        <Button label="取消" severity="secondary" text :disabled="clearing" @click="clearVisible = false" />
        <Button label="确认清空" severity="danger" :loading="clearing" @click="clearArchiveContent" ><template #icon><Trash2 :size="16" :stroke-width="1.8" /></template></Button>
      </template>
    </Dialog>

    <Dialog v-model:visible="deleteVisible" modal :draggable="false" :closable="!deleting" :close-on-escape="!deleting" header="删除当前账号数据？" class="settings-dialog">
      <div class="confirm">
        <span class="confirm__icon is-danger"><Trash2 :size="20" :stroke-width="1.8" /></span>
        <div>
          <p>当前账号的本地记录和已保存媒体将被删除，其他账号的数据会保留。</p>
          <small>包括动态、留言、评论、点赞、续传记录、媒体文件和 QQ 登录状态。旧版迁移备份与另存的导出文件需自行删除。</small>
        </div>
      </div>
      <p v-if="error" role="alert" class="settings-error">{{ describeError(error, '删除失败，请重试。') }}</p>
      <template #footer>
        <Button label="取消" severity="secondary" text :disabled="deleting" @click="deleteVisible = false" />
        <Button label="确认删除" severity="danger" :loading="deleting" @click="deleteEverything" ><template #icon><Trash2 :size="16" :stroke-width="1.8" /></template></Button>
      </template>
    </Dialog>

    <Dialog v-model:visible="seatsVisible" modal :draggable="false" header="管理设备" class="settings-dialog">
      <div class="seats">
        <p class="seats__hint">
          一个账号最多可在 <strong>{{ licenseStore.view?.maxSeats || "若干" }}</strong> 台设备上使用，
          电脑与手机共用这些名额。
        </p>
        <p class="seats__hint">自助解绑每 30 天限一次。解绑后该设备下次启动需要重新激活。</p>

        <ul v-if="licenseStore.seats.length" class="seats__list">
          <li v-for="seat in licenseStore.seats" :key="seat.id">
            <div class="seats__main">
              <span class="seats__name">
                {{ seat.label || "未命名设备" }}
                <em v-if="seat.current">本机</em>
              </span>
              <span class="seats__meta">{{ seat.platform || "未知平台" }} · 最近使用 {{ formatDate(seat.last_seen) }}</span>
            </div>
            <Button
              v-if="!seat.current"
              label="解绑"
              size="small"
              severity="danger"
              text
              :loading="seatsBusy"
              @click="askRelease(seat)"
            />
          </li>
        </ul>
        <p v-else-if="!seatsBusy && !seatError" class="seats__hint">暂无设备记录。</p>

        <p v-if="seatsBusy" role="status" class="seats__hint">正在读取设备列表…</p>
        <p v-if="seatError" role="alert" class="settings-error">{{ seatError }}</p>
        <p v-if="seatMessage" role="status" class="seats__message">{{ seatMessage }}</p>
      </div>
      <template #footer>
        <Button label="刷新" severity="secondary" text :loading="seatsBusy" @click="refreshSeats" />
        <Button label="退出本机授权" severity="danger" outlined :disabled="archiveStore.busy || seatsBusy" @click="askSignOut" />
        <Button label="关闭" @click="seatsVisible = false" />
      </template>
    </Dialog>
    <Dialog v-model:visible="accountConfirmVisible" modal :draggable="false" :closable="!accountActionBusy" :close-on-escape="!accountActionBusy" :header="accountAction === 'release' ? '解绑这台设备？' : '退出本机授权？'" class="settings-dialog">
      <div class="prose">
        <p v-if="accountAction === 'release'">将解绑「{{ releaseTarget?.label || '未命名设备' }}」，该设备需要重新激活才能继续备份。自助解绑每 30 天限一次。</p>
        <p v-else>本机需要重新激活才能继续备份。已有备份会保留，此操作不会释放设备名额。</p>
        <p v-if="confirmError" role="alert" class="settings-error">{{ confirmError }}</p>
      </div>
      <template #footer><Button label="取消" severity="secondary" text :disabled="accountActionBusy" @click="accountConfirmVisible = false" /><Button :label="accountAction === 'release' ? '解绑设备' : '退出授权'" severity="danger" :loading="accountActionBusy" @click="confirmAccountAction" /></template>
    </Dialog>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------- 设置行 */

.setting-row + .setting-row {
  border-top: var(--line-width) solid var(--color-border);
}

.setting-row:first-child {
  padding-top: 0;
}

.setting-row:last-child {
  padding-bottom: 0;
}

.setting-row__label {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.setting-row__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}

.setting-row__icon.is-danger {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.setting-row__label strong {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.setting-row__label:has(> strong) {
  flex-direction: column;
  gap: var(--space-1);
}

.setting-row__label small {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
  max-width: 52ch;
}

/* --------------------------------------------------------- 分段控件 */

.segmented {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  flex-shrink: 0;
}

.segmented__item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.segmented__item:hover {
  color: var(--color-text);
}

.segmented__item.is-active {
  background: var(--color-surface);
  color: var(--color-text);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-xs);
}

/* --------------------------------------------------------- 间隔设置 */

.interval-control {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}

.interval-control small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.interval-control :deep(.p-inputnumber-input) {
  width: 118px;
}

/* ------------------------------------------------------------- 关于 */

.about {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.about__mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: var(--radius-md);
  background: var(--gradient-brand);
  color: var(--color-on-accent);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
}

.about__head strong {
  display: block;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.about__head span {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.about__version {
  margin-left: auto;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  font-size: var(--text-xs) !important;
  color: var(--color-text-secondary) !important;
  font-variant-numeric: tabular-nums;
}

.about__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3) var(--space-5);
  margin: 0;
}

.about__meta > div {
  display: flex;
  gap: var(--space-2);
  font-size: var(--text-xs);
  min-width: 0;
}

.about__meta dt {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.about__meta dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.about__mono {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}

.about__update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.about__update-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.about__update-text strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.about__update-text small {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.about__notice {  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.about__privacy {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  align-self: flex-start;
  padding: var(--space-2) var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.about__privacy:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

/* --------------------------------------------------------- 弹窗内容 */

.prose h4 {
  margin: var(--space-4) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}

.prose p {
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.confirm {
  display: flex;
  gap: var(--space-3);
}

.confirm__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.confirm__icon.is-danger {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.confirm p {
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.confirm small {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.seats {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.seats__hint {
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.seats__list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.seats__list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
}

.seats__main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.seats__name {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seats__name em {
  margin-left: var(--space-2);
  padding: var(--line-width) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--text-2xs);
  font-style: normal;
}

.seats__meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.seats__message {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  font-size: var(--text-xs);
}

.settings-error {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-xs);
}

/* --------------------------------------------------------- 响应式 */

@media (max-width: 860px) {
  .setting-row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .segmented,
  .interval-control {
    align-self: flex-start;
  }
}

.settings-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-5); max-width:var(--layout-reading-width); }
.settings-stack :deep(.qza-card__head) { background:var(--color-surface); }
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) 0; gap:var(--space-6); }
.segmented__item[aria-pressed="true"] { color:var(--color-accent); }
.about__head {
  display: flex;
  align-items: center;
  gap: var(--space-3); flex-wrap:wrap; }
.about__meta dd {
  margin: 0;
  overflow: hidden; overflow-wrap:anywhere; min-width:0; }
@media (max-width:860px) { .setting-row { flex-wrap:wrap; align-items:flex-start; gap:var(--space-3); } .segmented { flex-wrap:wrap; } .segmented__item { min-height:var(--touch-target); } .interval-control { width:100%; } }


/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .settings-stack { max-width:var(--layout-section-max); gap:var(--layout-page-gap); }
.setting-row { min-height:var(--density-row-height); padding-block:var(--space-4); align-items:center; gap:var(--space-4); }
.setting-row__icon { width:var(--layout-stat-icon); height:var(--layout-stat-icon); background:var(--color-surface-sunken); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); }
.setting-row__label strong { font-size:var(--text-sm); }
.segmented { border-radius:var(--radius-md); padding:var(--space-1); background:var(--color-surface-sunken); }
.segmented__item { min-height:var(--control-compact); padding:var(--space-1) var(--space-3); }
.segmented__item.is-active { background:var(--color-surface); box-shadow:var(--shadow-xs); }
@media(max-width:600px) { .setting-row { align-items:flex-start; gap:var(--space-3); } .segmented__item { min-height:var(--touch-target); } }
</style>
