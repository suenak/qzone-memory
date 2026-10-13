<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Info, LoaderCircle, ShieldCheck } from "lucide-vue-next";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import AppShell from "./layouts/AppShell.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import { useAuthStore } from "./stores/auth";
import { useLicenseStore } from "./stores/license";
import { useUpdateStore } from "./stores/update";

const route = useRoute();
const authStore = useAuthStore();
const licenseStore = useLicenseStore();
const updateStore = useUpdateStore();
const pageTitle = computed(() => String(route.meta.title ?? "恢复备份"));
const DISCLAIMER_VERSION = "2026-10-09-v4";
const DISCLAIMER_KEY = "qzone-archive-disclaimer";
const disclaimerAccepted = ref(localStorage.getItem(DISCLAIMER_KEY) === DISCLAIMER_VERSION);
const acceptanceChecked = ref(false);

/**
 * 授权检查排在免责声明之后：未同意条款时不应发起任何网络请求。
 * 心跳只是尽力而为——网络不通时本地宽限期仍然成立，不阻塞进入应用。
 */
async function bootstrapLicense() {
  await licenseStore.refresh();
  if (licenseStore.view?.username) void licenseStore.heartbeat();
}

/**
 * 启动时的静默检查：有新版才弹窗，其余情况一概不打扰。
 *
 * 与授权检查一样排在免责声明之后——未同意条款前不应发起任何网络请求。
 * 刻意不 await：检查失败（没联网、更新服务未部署）对用户毫无影响，
 * 不该让他为一次无关的请求多等哪怕一秒。失败也不提示，只有真的有新版才出声。
 */
function checkForUpdatesOnStartup() {
  updateStore.startAutomaticChecks();
}

const licenseNotice = computed(() => (licenseStore.activated ? (licenseStore.view?.message ?? "").replace(/归档/g, "备份") : ""));

if (disclaimerAccepted.value) {
  void authStore.restoreSession();
  void bootstrapLicense();
  checkForUpdatesOnStartup();
}
function retryPersistedSession() {
  if (disclaimerAccepted.value && !authStore.loggedIn && document.visibilityState === "visible") {
    void authStore.restoreSession();
  }
}
onMounted(() => {
  window.addEventListener("focus", retryPersistedSession);
  document.addEventListener("visibilitychange", retryPersistedSession);
});
onBeforeUnmount(() => {
  updateStore.stopAutomaticChecks();
  window.removeEventListener("focus", retryPersistedSession);
  document.removeEventListener("visibilitychange", retryPersistedSession);
});
function acceptDisclaimer() {
  if (!acceptanceChecked.value) return;
  localStorage.setItem(DISCLAIMER_KEY, DISCLAIMER_VERSION);
  disclaimerAccepted.value = true;
  void authStore.restoreSession();
  void bootstrapLicense();
  checkForUpdatesOnStartup();
}
async function declineDisclaimer() {
  try {
    await invoke("exit_app");
  } catch {
    // Vite/browser preview has no native process to exit; close the window when possible.
    try { await getCurrentWindow().close(); } catch { /* no-op */ }
  }
}
</script>

<template>
  <AppShell v-if="disclaimerAccepted && licenseStore.initialized" :page-title="pageTitle">
    <RouterView v-slot="{ Component, route: currentRoute }">
      <Transition name="native-page">
        <component :is="Component" :key="currentRoute.name" />
      </Transition>
    </RouterView>
  </AppShell>

  <div v-else class="disclaimer-gate"><p v-if="disclaimerAccepted" class="startup-status" role="status"><LoaderCircle :size="20" :stroke-width="1.8" class="is-spinning" />正在检查授权…</p></div>

  <!-- 宽限期与受限提示固定底部，避免干扰既有布局 -->
  <div v-if="licenseNotice" class="license-notice" :class="{ 'is-hard': licenseStore.restricted }">
    <Info :size="15" :stroke-width="1.8" />
    <span>{{ licenseNotice }}</span>
  </div>

  <ToastHost />

  <!-- 更新提示必须是全局的：启动检查发生时用户可能停在任何页面，设置页甚至尚未挂载。 -->
  <UpdateDialog />
  <Dialog :visible="!disclaimerAccepted" modal :closable="false" :draggable="false" :close-on-escape="false" class="disclaimer-dialog" header="免责声明与使用须知">
    <div class="disclaimer-heading"><span><ShieldCheck :size="19" :stroke-width="1.8" /></span><div><strong>使用前请确认</strong><small>本地备份工具 · 非 QQ 官方产品</small></div></div>
    <ul class="disclaimer-summary"><li>仅备份本人或已获授权的账号内容。</li><li>已删除内容只能尝试恢复，结果可能不完整。</li><li>请另存重要文件，备份过程中不要切换 QQ 账号。</li></ul>
    <details class="disclaimer-full"><summary>阅读全文与数据处理说明</summary>
    <div class="disclaimer-content">
      <section><h4>一、软件性质、来源与非官方声明</h4><p>拾忆（以下简称“本软件”）是基于 Gaoshu705/QzoneArchive 二次开发的本地工具，并参考 LibraHp/GetQzonehistory 的历史取数思路以及 ShunCai/QZoneExport 的空间资料接口实现；本项目遵循 GPLv3，QZoneExport 参考实现遵循 Apache-2.0。本软件与腾讯公司、QQ、QQ 空间及其关联主体不存在隶属、授权、合作、代理或担保关系，原项目和参考项目作者也不对本分支提供背书或担保。QQ、QQ 空间及相关名称、商标、接口与内容权利归相应权利人所有。</p></section>
      <section><h4>二、授权范围与账号责任</h4><p>你确认仅使用本人账号，或已获得账号所有人及相关内容权利人的合法、充分授权。你应妥善保管设备、二维码、Cookie、导出文件和缓存，不得出借账号、冒用身份或允许未经授权者访问。因账号共享、设备遗失、恶意软件、系统越权或保管不当造成的风险由相应责任方依法承担。</p></section>
      <section><h4>三、合法合规使用</h4><p>本软件仅供合法的个人备份、查阅与数据迁移使用。禁止用于非法侵入、批量爬取他人资料、绕过访问控制或技术保护、监控骚扰、撞库盗号、数据买卖、商业营销、侵犯隐私、侵犯著作权、传播违法有害信息，以及任何违反法律法规、公共秩序、第三方协议或平台规则的行为。不得利用本软件危害网络和数据安全。</p></section>
      <section><h4>四、个人信息与他人权益</h4><p>备份可能包含你及其他用户的 QQ 号、昵称、头像、动态、图片、视频、留言、评论和互动记录。你应遵循合法、正当、必要和最小范围原则，不得超出授权目的处理、公开或传播他人信息。向第三方分享 HTML、图片、视频或数据库前，应自行完成权限确认、必要脱敏并取得所需同意。</p></section>
      <section><h4>五、著作权与内容责任</h4><p>备份功能不改变任何内容的著作权、肖像权、名誉权、隐私权或其他权利归属。你仅可在法律允许或权利人授权范围内复制、保存、改编、展示和传播内容。因你导出、转载、公开、交易或以其他方式使用备份内容引发的争议，由你依法承担相应责任。</p></section>
      <section><h4>六、本地存储与网络请求</h4><p>备份数据库、登录会话和媒体缓存主要保存在当前设备的应用数据目录。本软件会为登录、读取资料和下载媒体连接腾讯相关域名；激活与授权更新会连接授权服务，发送授权账号和设备信息。操作系统、WebView、网络运营商、第三方平台及你安装的其他软件可能按各自规则处理网络或设备信息；你应同时阅读并遵守其隐私政策与服务条款。</p></section>
      <section><h4>七、数据丢失与备份风险</h4><p>软件可能因接口变更、临时签名过期、网络中断、限流、账号权限、数据库损坏、设备故障、系统清理、存储不足、升级卸载或误操作出现遗漏、重复、乱码、媒体失效或数据丢失。备份结果不构成唯一、永久或完整备份。请定期核验并将重要资料备份到安全位置；执行“删除所有数据”前应确认已完成必要备份。</p></section>
      <section><h4>八、恢复能力与可用性说明</h4><p>“恢复已删除说说”仅指从服务端仍返回的点赞、评论、回复等互动记录中尝试还原相关内容；没有互动痕迹、已被服务端彻底清除、无权访问或接口不再返回的内容无法恢复。本软件按现状提供，不保证结果完整、无错误、不中断或长期兼容第三方接口。请求间隔、重试和断点续传只能降低部分失败概率，不能消除封禁、限流、接口停用或内容不可恢复风险。</p></section>
      <section><h4>九、责任边界</h4><p>在法律允许范围内，开发者不对第三方服务中断、不可抗力、设备或网络环境、用户违规操作、未授权使用以及未按提示备份造成的间接损失或可避免的数据损失承担超出法律规定的责任。本条不排除或限制依法不得排除的责任，也不免除因故意或重大过失依法应承担的责任。</p></section>
      <section><h4>十、未成年人、协议更新与争议</h4><p>未成年人应在监护人阅读并同意后使用。功能、风险或法律规则发生变化时，本须知可能更新；版本变化后将再次征求确认。条款部分无效不影响其他条款效力。发生争议时应先停止相关操作、保存必要证据并依法协商或通过有管辖权的机构解决。</p></section>
      <p class="disclaimer-note">点击同意不代表你放弃依法享有的权利，而表示你已充分了解工具性质、数据处理方式和可预见风险，并承诺在合法授权范围内使用。</p>
    </div>
    </details>
    <label class="disclaimer-confirm"><Checkbox v-model="acceptanceChecked" binary input-id="accept-disclaimer" /><span>我已完整阅读并理解上述内容，同意《免责声明与使用须知》，并承诺仅在合法授权范围内使用本软件。</span></label>
    <template #footer><Button label="不同意并退出" severity="secondary" text @click="declineDisclaimer" /><Button label="同意并进入" :disabled="!acceptanceChecked" @click="acceptDisclaimer" ><template #icon><Check :size="16" :stroke-width="1.8" /></template></Button></template>
  </Dialog>
</template>

<style scoped>
.license-notice {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: min(560px, calc(100vw - 40px));
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--color-warning);
  background: var(--color-surface-raised);
  border: var(--line-width) solid var(--color-warning);
  box-shadow: var(--shadow-lg);
}

.license-notice.is-hard {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

.update-body h4 {
  margin: var(--space-3) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

/* ------------------------------------------------- 免责声明闸门
 * 原先依赖全局样式表，现已随组件自带，避免旧样式清理后闸门塌掉。 */

.disclaimer-gate {
  position: fixed;
  inset: 0;
  background: var(--color-canvas);
}
.startup-status { display:flex; align-items:center; justify-content:center; gap:var(--space-3); height:100%; color:var(--color-text-secondary); font-size:var(--text-sm); }
.disclaimer-summary { margin:0 0 var(--space-4); padding-left:var(--space-5); color:var(--color-text); font-size:var(--text-sm); line-height:var(--leading-relaxed); }
.disclaimer-summary li + li { margin-top:var(--space-2); }
.disclaimer-full summary { cursor:pointer; color:var(--color-accent); padding:var(--space-2) 0; font-size:var(--text-sm); }

.disclaimer-dialog {
  width: min(94vw, 760px);
}

.disclaimer-heading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  border: var(--line-width) solid var(--color-accent-border);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
}

.disclaimer-heading > span {
  display: grid;
  place-items: center;
  flex: 0 0 38px;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: var(--gradient-brand);
  color: var(--color-on-accent);
}

.disclaimer-heading strong,
.disclaimer-heading small {
  display: block;
}

.disclaimer-heading strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}

.disclaimer-heading small {
  margin-top: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.disclaimer-content {
  max-height: min(55vh, 560px);
  padding-right: var(--space-2);
  overflow-y: auto;
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.disclaimer-content section {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.disclaimer-content section + section {
  margin-top: var(--space-2);
}

.disclaimer-content h4 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}

.disclaimer-content p {
  margin: 0;
}

.disclaimer-note {
  margin: var(--space-3) var(--space-1) 0;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.disclaimer-confirm {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text);
  cursor: pointer;
}

.disclaimer-confirm :deep(.p-checkbox) {
  flex: 0 0 auto;
  margin-top: var(--line-width);
}

/* 只在新页面进入时轻微淡入，不延迟旧页面退出或后台任务。 */
.native-page-enter-active { animation:client-page-enter var(--duration-fast) var(--ease-out); }
@keyframes client-page-enter { from { opacity:0; transform:translateY(var(--space-1)); } to { opacity:1; transform:translateY(0); } }
</style>
