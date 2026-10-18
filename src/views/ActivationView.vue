<script setup lang="ts">
import { describeLicenseError } from "../utils/uiError";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { BookOpen, CircleAlert, CircleCheck, ShieldCheck, LockKeyhole, Ticket, Trash2, Sun, Moon, Monitor } from "lucide-vue-next";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import { useLicenseStore, type LicenseSeat } from "../stores/license";
import { useAppStore } from "../stores/app";
import { platform } from "../utils/platform";

const store = useLicenseStore();
const appStore = useAppStore();
const router = useRouter();
const route = useRoute();
const mobilePlatform = ["android", "ios"].includes(platform());

type Mode = "activate" | "redeem";

const mode = ref<Mode>("activate");
const username = ref("");
const password = ref("");
const deviceLabel = ref("");
const code = ref("");
const submitting = ref(false);
const busy = computed(() => submitting.value || store.loading);
const error = ref("");
const notice = ref("");
const blockedSeats = ref<LicenseSeat[]>([]);

const releaseVisible = ref(false);
const releaseTarget = ref<LicenseSeat | null>(null);
const releasePassword = ref("");
const releaseError = ref("");
let releaseAccount = "";
let disposed = false;
let requestSequence = 0;
const isCurrent = (run: number) => !disposed && run === requestSequence;
function clearRelease() { releaseTarget.value = null; releasePassword.value = ""; releaseError.value = ""; releaseAccount = ""; }
function validation(message: string, id: string) {
  const run = requestSequence;
  error.value = message;
  void nextTick(() => { if (isCurrent(run)) document.getElementById(id)?.focus(); });
}
watch(username, () => {
  requestSequence += 1;
  blockedSeats.value = [];
  error.value = "";
  notice.value = "";
  releaseVisible.value = false;
  clearRelease();
}, { flush: "sync" });
watch(releaseVisible, (visible) => { if (!visible) clearRelease(); }, { flush: "sync" });
onBeforeUnmount(() => {
  disposed = true;
  requestSequence += 1;
  password.value = "";
  code.value = "";
  clearRelease();
});

const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows 电脑",
  macos: "Mac",
  linux: "Linux 电脑",
  android: "Android 手机",
  ios: "iPhone / iPad",
};

const platformLabel = computed(() => PLATFORM_LABELS[store.view?.platform ?? ""] ?? "本设备");

const shortId = computed(() => {
  const value = store.view?.installationId ?? "";
  return value ? value.slice(0, 8) : "初始化中";
});

function formatTime(seconds: number) {
  if (!seconds) return "未知";
  return new Date(seconds * 1000).toLocaleDateString("zh-CN");
}

function switchMode() {
  if (disposed || busy.value) return;
  mode.value = mode.value === "activate" ? "redeem" : "activate";
  error.value = "";
  notice.value = "";
  blockedSeats.value = [];
  releaseVisible.value = false;
}

async function submit() {
  if (disposed || busy.value || mode.value !== "activate") return;
  error.value = "";
  notice.value = "";
  if (!username.value.trim()) { validation("填写授权账号。", "license-username"); return; }
  if (!password.value) { validation("填写授权密码。", "license-password"); return; }

  const run = ++requestSequence;
  const target = typeof route.query.returnTo === "string" && route.query.returnTo.startsWith("/") && !route.query.returnTo.startsWith("//") && !route.query.returnTo.startsWith("/activation") ? route.query.returnTo : "/";
  submitting.value = true;
  try {
    const outcome = await store.activate(username.value.trim(), password.value, deviceLabel.value.trim());
    if (!isCurrent(run)) return;
    if (outcome.success) {
      notice.value = "激活成功，正在进入应用…";
      password.value = "";
      blockedSeats.value = [];
      await router.replace(target);
      return;
    }
    // 业务性失败（口令错误、席位已满）由后端以 success=false 返回，此处可拿到占用设备列表。
    error.value = outcome.message;
    blockedSeats.value = outcome.seats ?? [];
  } catch (reason) {
    if (!isCurrent(run)) return;
    error.value = typeof reason === "string" ? reason : "激活失败，请检查网络后重试";
  } finally {
    if (!disposed) submitting.value = false;
  }
}

async function submitRedeem() {
  if (disposed || busy.value || mode.value !== "redeem") return;
  error.value = "";
  notice.value = "";
  if (!username.value.trim()) { validation("填写授权账号。", "license-username"); return; }
  if (!password.value) { validation("填写授权密码。", "license-password"); return; }
  if (!code.value.trim()) { validation("填写卡密。", "license-code"); return; }

  const run = ++requestSequence;
  submitting.value = true;
  try {
    await store.redeem(username.value.trim(), password.value, code.value.trim());
    if (!isCurrent(run)) return;
    notice.value = "兑换成功，返回激活即可使用。";
    code.value = "";
  } catch (reason) {
    if (!isCurrent(run)) return;
    error.value = typeof reason === "string" ? reason : "兑换失败，请稍后重试";
  } finally {
    if (!disposed) submitting.value = false;
  }
}

function openRelease(seat: LicenseSeat) {
  if (disposed || busy.value || !blockedSeats.value.some((item) => item.id === seat.id)) return;
  releaseTarget.value = { ...seat };
  releaseAccount = username.value.trim();
  releasePassword.value = password.value;
  releaseError.value = "";
  releaseVisible.value = true;
}

async function confirmRelease() {
  if (disposed || busy.value || !releaseVisible.value) return;
  const seat = releaseTarget.value;
  if (!seat || !releaseAccount || releaseAccount !== username.value.trim() || !blockedSeats.value.some((item) => item.id === seat.id)) return;
  if (!releasePassword.value) {
    releaseError.value = "填写授权密码以确认解绑。";
    return;
  }

  const run = ++requestSequence;
  submitting.value = true;
  try {
    await store.deactivateSeat(seat.id, releaseAccount, releasePassword.value);
    if (!isCurrent(run) || !releaseVisible.value || releaseTarget.value?.id !== seat.id) return;
    blockedSeats.value = blockedSeats.value.filter((item) => item.id !== seat.id);
    releaseVisible.value = false;
    releasePassword.value = "";
    notice.value = `已解绑「${seat.label || seat.id}」，现在可以重新激活`;
  } catch (reason) {
    if (!isCurrent(run) || !releaseVisible.value) return;
    releaseError.value = describeLicenseError(reason, "解绑失败，请重试。");
  } finally {
    if (!disposed) submitting.value = false;
  }
}
</script>

<template>
  <div>
  <div class="activation-stage" :class="{ 'is-mobile': mobilePlatform }">
    <aside class="activation-story">
      <p class="activation-story__brand"><img src="/branding/shiyi-logo-v2-mark-256.png" alt="" />拾忆</p>
      <h2>找回有线索的<br />已删说说。</h2>
      <p>曾有点赞或评论，且记录仍可读取的说说，才有机会找回。已保存的内容随时可查看和导出。</p>
      <ul><li><BookOpen :size="18" :stroke-width="1.8" /><span>按年份查看说说与照片</span></li><li><ShieldCheck :size="18" :stroke-width="1.8" /><span>本地备份，资料由你保管</span></li></ul>
      <div class="activation-themes" role="group" aria-label="界面主题"><button type="button" :aria-pressed="appStore.themeMode === 'light'" @click="appStore.setTheme('light')"><Sun :size="16" :stroke-width="1.8" />浅色</button><button type="button" :aria-pressed="appStore.themeMode === 'dark'" @click="appStore.setTheme('dark')"><Moon :size="16" :stroke-width="1.8" />深色</button><button type="button" :aria-pressed="appStore.themeMode === 'system'" @click="appStore.setTheme('system')"><Monitor :size="16" :stroke-width="1.8" />系统</button></div>
    </aside>
    <section class="activation-card">
      <p v-if="route.query.returnTo" class="activation-intro">请先完成软件授权，再登录 QQ 空间。已有的本地记录仍可查看。</p>
      <header class="activation-head">
        <span class="activation-mark"><ShieldCheck :size="22" :stroke-width="1.8" /></span>
        <h1>{{ mode === "activate" ? "激活本设备" : "兑换卡密" }}</h1>
        <p>
          {{
            mode === "activate"
              ? "使用授权账号激活，这里的账号不是 QQ 账号。"
              : "为已有授权账号兑换时长或设备名额。"
          }}
        </p>
      </header>

      <form v-if="mode === 'activate'" class="activation-form" @submit.prevent="submit">
        <label class="activation-field">
          <span>授权账号</span>
          <InputText id="license-username" :disabled="busy" v-model="username" placeholder="填写授权账号" autocomplete="username" />
        </label>
        <label class="activation-field">
          <span>授权密码</span>
          <Password input-id="license-password" :disabled="busy" :input-props="{ autocomplete: 'current-password' }" v-model="password" :feedback="false" prompt-label="请输入密码" toggle-mask placeholder="填写授权密码" input-class="activation-password" />
        </label>
        <label class="activation-field">
          <span>设备名称 <small>（选填，用于区分设备）</small></span>
          <InputText v-model="deviceLabel" :disabled="busy" :placeholder="platformLabel" />
        </label>
        <Button
          type="submit"
          label="激活本设备"
          :loading="busy"
          class="activation-submit"
        ><template #icon><LockKeyhole :size="16" :stroke-width="1.8" /></template></Button>
      </form>

      <form v-else class="activation-form" @submit.prevent="submitRedeem">
        <label class="activation-field">
          <span>授权账号</span>
          <InputText id="license-username" :disabled="busy" v-model="username" placeholder="你的授权账号" autocomplete="username" />
        </label>
        <label class="activation-field">
          <span>授权密码</span>
          <Password input-id="license-password" :disabled="busy" :input-props="{ autocomplete: 'current-password' }" v-model="password" :feedback="false" prompt-label="请输入密码" toggle-mask placeholder="你的授权密码" input-class="activation-password" />
        </label>
        <label class="activation-field">
          <span>卡密</span>
          <InputText id="license-code" :disabled="busy" v-model="code" placeholder="XXXX-XXXX-XXXX-XXXX" class="activation-code" />
        </label>
        <Button type="submit" label="兑换" :loading="busy" class="activation-submit"><template #icon><Ticket :size="16" :stroke-width="1.8" /></template></Button>
      </form>

      <p v-if="error" class="activation-alert is-error" role="alert">
        <CircleAlert :size="14" :stroke-width="2" /><span>{{ describeLicenseError(error, error) }}</span>
      </p>
      <p v-if="notice" class="activation-alert is-ok" role="status">
        <CircleCheck :size="14" :stroke-width="2" /><span>{{ notice }}</span>
      </p>

      <div v-if="blockedSeats.length" class="activation-seats">
        <h3>可用设备名额已用完</h3>
        <p>解绑一台不再使用的设备后可激活本机。自助解绑每 30 天限一次。</p>
        <ul>
          <li v-for="seat in blockedSeats" :key="seat.id">
            <div class="activation-seat-main">
              <span class="activation-seat-name">{{ seat.label || "未命名设备" }}</span>
              <span class="activation-seat-meta">
                {{ PLATFORM_LABELS[seat.platform] ?? seat.platform }} · 最近使用 {{ formatTime(seat.last_seen) }}
              </span>
            </div>
            <Button label="解绑" size="small" severity="danger" text :disabled="busy" @click="openRelease(seat)" />
          </li>
        </ul>
      </div>

      <footer class="activation-foot">
        <button type="button" class="activation-link" :disabled="busy" @click="switchMode">
          {{ mode === "activate" ? "兑换卡密" : "返回激活" }}
        </button>
        <span class="activation-device" :title="store.view?.installationId ?? ''">设备标识 {{ shortId }}</span>
      </footer>
    </section>
  </div>

  <Dialog v-model:visible="releaseVisible" modal :draggable="false" :closable="!busy" :close-on-escape="!busy" class="activation-dialog" header="解绑设备">
    <div class="activation-dialog-body">
      <p>
        即将解绑
        <strong>{{ releaseTarget?.label || releaseTarget?.id }}</strong>
        。该设备下次启动时将要求重新激活。
      </p>
      <label class="activation-field">
        <span>请输入账号密码以确认</span>
        <Password v-model="releasePassword" :disabled="busy" :feedback="false" prompt-label="请输入密码" toggle-mask placeholder="账号密码" input-class="activation-password" />
      </label>
      <p v-if="releaseError" class="activation-alert is-error" role="alert">
        <CircleAlert :size="14" :stroke-width="2" /><span>{{ releaseError }}</span>
      </p>
    </div>
    <template #footer>
      <Button label="取消" severity="secondary" text :disabled="busy" @click="releaseVisible = false" />
      <Button label="确认解绑" severity="danger" :loading="busy" @click="confirmRelease"><template #icon><Trash2 :size="16" :stroke-width="1.8" /></template></Button>
    </template>
  </Dialog>
  </div>
</template>

<style scoped>
.activation-stage { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,var(--layout-dialog-width)); align-items:center; gap:var(--space-16); width:100%; height:100dvh; max-width:var(--layout-content-max); margin:0 auto; padding:var(--space-12); overflow-y:auto; background:var(--color-canvas); }
.activation-story { max-width:56ch; }
.activation-story__brand { display:flex; align-items:center; gap:var(--space-3); margin-bottom:var(--space-16); color:var(--color-accent); font-weight:var(--weight-semibold); }
.activation-story h2 { font-size:var(--text-display); line-height:1.35; font-family:var(--font-display); letter-spacing:-.025em; margin-bottom:var(--space-6); }
.activation-story > p:not(.activation-story__brand) { font-size:var(--text-md); color:var(--color-text-secondary); line-height:var(--leading-relaxed); }
.activation-story ul { list-style:none; margin:var(--space-8) 0; padding:0; display:flex; flex-direction:column; gap:var(--space-4); }
.activation-story li { display:flex; align-items:center; gap:var(--space-3); font-size:var(--text-sm); color:var(--color-text-secondary); }
.activation-story li svg { color:var(--color-accent); }
.activation-themes { display:flex; flex-wrap:wrap; gap:var(--space-2); }
.activation-themes button { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) var(--space-3); min-height:var(--control-height); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); background:var(--color-surface); font-size:var(--text-xs); }
.activation-themes button[aria-pressed="true"] { background:var(--color-accent-soft); border-color:var(--color-accent-border); color:var(--color-accent); }

.activation-head p {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.activation-form { display: flex; flex-direction: column; gap: var(--space-4); }

.activation-field { display: flex; flex-direction: column; gap: var(--space-2); }

.activation-field > span {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.activation-field > span small { opacity: 0.7; }

.activation-field :deep(.p-inputtext),
.activation-field :deep(.p-password),
.activation-field :deep(.p-password-input) { width: 100%; }

.activation-code :deep(input),
.activation-code { letter-spacing: 1.5px; font-family: ui-monospace, Consolas, monospace; }

.activation-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  padding: var(--space-3) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.activation-alert.is-error { background: var(--color-danger-soft); color: var(--color-danger); }
.activation-alert.is-ok { background: var(--color-success-soft); color: var(--color-success); }

.activation-seats {
  margin-top: var(--space-5);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: var(--line-width) solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 3%, transparent);
}

.activation-seats h3 { margin: 0 0 var(--space-2); font-size: var(--text-base); }

.activation-seats > p {
  margin: 0 0 var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.65;
  color: var(--color-text-secondary);
}

.activation-seats ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }

.activation-seats li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}

.activation-seat-main { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.activation-seat-name { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activation-seat-meta { font-size: var(--text-xs); color: var(--color-text-secondary); }

.activation-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: var(--line-width) solid var(--color-border);
}

.activation-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--color-accent);
  font-size: var(--text-sm);
  cursor: pointer;
}

.activation-link:hover { text-decoration: underline; }

.activation-device {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-family: ui-monospace, Consolas, monospace;
}

.activation-dialog-body { display: flex; flex-direction: column; gap: var(--space-4); }
.activation-dialog-body > p { margin: 0; font-size: var(--text-sm); line-height: 1.7; }

.activation-card {
  max-width: var(--layout-dialog-width);
  border: var(--line-width) solid var(--color-border);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg); width:100%; min-width:0; border-radius:var(--radius-xl); padding:var(--space-8); }
.activation-head { margin-bottom: var(--space-5); text-align:left; }
.activation-head h1 { margin: 0 0 var(--space-2); font-weight: var(--weight-semibold); font-size:var(--text-2xl); line-height:var(--leading-tight); }
.activation-mark {
  display: inline-grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: var(--space-4);
  border-radius: var(--radius-lg);
  font-size: var(--text-xl); margin:0 0 var(--space-5); background:var(--color-accent-soft); color:var(--color-accent); }
.activation-submit { width: 100%; margin-top: var(--space-1); min-height:var(--touch-target); }
@media(max-width:860px) { .activation-stage { grid-template-columns:minmax(0,1fr); gap:var(--space-6); padding:var(--space-5); align-items:start; justify-items:center; } .activation-story { width:100%; max-width:var(--layout-dialog-width); } .activation-story__brand { margin-bottom:var(--space-4); } .activation-story h2 { font-size:var(--text-2xl); } .activation-story > p:not(.activation-story__brand),.activation-story ul { display:none; } .activation-themes { margin-top:var(--space-4); } .activation-card { padding:var(--space-5); } }

/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .activation-stage { height:auto; min-height:calc(100dvh - var(--layout-topbar-height) - var(--space-10)); overflow:visible; padding:var(--space-6) var(--space-4); gap:var(--space-10); }
.activation-story { padding:var(--space-4); }
.activation-story__brand { color:var(--color-text); font-family:var(--font-display); }
.activation-story__brand img { width:var(--space-8); height:var(--space-8); object-fit:contain; }
.activation-story h2 { font-size:var(--text-3xl); line-height:var(--leading-tight); letter-spacing:normal; }
.activation-card { border-radius:var(--radius-lg); padding:var(--space-6); box-shadow:var(--shadow-sm); }
.activation-head h1 { font-size:var(--text-xl); }
.activation-mark { width:var(--control-height); height:var(--control-height); margin-bottom:var(--space-3); border-radius:var(--radius-md); }
@media(max-width:600px) { .activation-stage { min-height:0; padding:var(--space-2); gap:var(--space-4); } .activation-story { padding:0; } .activation-story h2 { font-size:var(--text-xl); } .activation-card { padding:var(--space-5); } }

@media(max-width:600px) { .activation-story__brand { margin-bottom:var(--space-2); } .activation-story h2 { font-size:var(--text-lg); } .activation-story h2 br { display:none; } .activation-themes { margin-top:var(--space-2); } }
.activation-stage.is-mobile { grid-template-columns:minmax(0,1fr); min-height:0; align-items:start; justify-items:center; padding:var(--space-2); gap:var(--space-4); }
.is-mobile .activation-story { width:100%; max-width:var(--layout-dialog-width); padding:0; }
.is-mobile .activation-story__brand { margin-bottom:var(--space-2); }
.is-mobile .activation-story h2 { font-size:var(--text-lg); margin-bottom:var(--space-2); }
.is-mobile .activation-story h2 br { display:none; }
.is-mobile .activation-story > p:not(.activation-story__brand),.is-mobile .activation-story ul { display:none; }
.is-mobile .activation-themes { margin-top:var(--space-2); }
.is-mobile .activation-card { padding:var(--space-5); }
@media (orientation:landscape) and (min-width:700px) {
  .activation-stage.is-mobile { grid-template-columns:minmax(0,1fr) minmax(0,1.4fr); gap:var(--space-5); }
  .is-mobile .activation-story { padding-top:var(--space-3); }
  .is-mobile .activation-card { padding:var(--space-4); }
  .is-mobile .activation-mark { display:none; }
}
.activation-intro { padding:var(--space-3); margin-bottom:var(--space-4); color:var(--color-accent); background:var(--color-accent-soft); border-radius:var(--radius-md); font-size:var(--text-sm); line-height:var(--leading-relaxed); }
</style>
