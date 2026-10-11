<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { platform } from "../utils/platform";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  ExternalLink,
  Lock,
  Monitor,
  QrCode,
  RefreshCw,
} from "lucide-vue-next";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import SkeletonBlock from "./ui/SkeletonBlock.vue";
import { useAuthStore } from "../stores/auth";
import { describeError } from "../utils/uiError";

const authStore = useAuthStore();
const { dialogVisible, loading, qrImage, status, message, webLoginMode } = storeToRefs(authStore);
const showWebLogin = computed(() => {
  const currentPlatform = platform();
  return currentPlatform !== "android" && currentPlatform !== "ios";
});

/** 扫码流程收敛成五种视觉状态：等待扫码 / 已扫码待确认 / 已过期 / 出错 / 空档。
 *  「等待中但既没有二维码、也不在加载」是取图空档，单独归为 idle：
 *  这种状态必须留一个取图入口，否则用户会停在既没有二维码、也没有任何可点按钮的死路上。 */
const qrState = computed<"waiting" | "idle" | "scanned" | "expired" | "error">(() => {
  if (status.value === "scanned") return "scanned";
  if (status.value === "expired") return "expired";
  if (status.value === "error") return "error";
  if (!qrImage.value && !loading.value) return "idle";
  return "waiting";
});

/** 网页登录只有「进行中」和「中断」两种呈现。 */
const webState = computed(() =>
  status.value === "error" || status.value === "webLoginCancelled" ? "error" : "waiting",
);
</script>

<template>
  <Dialog
    :visible="dialogVisible"
    modal
    :draggable="false"
    :closable="true"
    class="qzl-dialog"
    style="width: min(440px, calc(100vw - var(--space-4) * 2))"
    @update:visible="(visible) => !visible && authStore.closeLogin()"
  >
    <template #header>
      <div class="qzl-brand">
        <span class="qzl-brand__mark" aria-hidden="true">
          <img class="qzl-brand__logo" src="/branding/shiyi-logo-v2-mark-256.png" alt="" />
        </span>
        <span class="qzl-brand__copy">
          <strong>登录 QQ 空间</strong>
          <small>使用手机 QQ 扫码并确认登录</small>
        </span>
      </div>
    </template>

    <!-- ------------------------------------------------------ 网页登录模式 -->
    <div v-if="webLoginMode" class="qzl-body">
      <div class="qzl-stage is-web">
        <SkeletonBlock v-if="loading" width="100%" height="100%" />
        <span v-else class="qzl-stage__placeholder">
          <Monitor :size="46" :stroke-width="1.6" aria-hidden="true" />
          <small>登录窗口已打开</small>
        </span>
      </div>

      <div class="qzl-status" :class="`is-${webState}`">
        <span class="qzl-status__dot" aria-hidden="true" />
        <p>{{ webState === 'error' ? describeError(message, '网页登录没有完成，可以重试或返回扫码登录。') : message }}</p>
      </div>

      <p class="qzl-note">
        请在 QQ 登录窗口中完成登录，成功后会自动返回。
      </p>

      <div class="qzl-actions">
        <Button
          label="返回扫码登录"
          severity="secondary"
          text
          @click="authStore.cancelWebLogin()"
        />
        <Button
          v-if="status === 'error' || status === 'webLoginCancelled'"
          label="重试网页登录"
          :loading="loading"
          @click="authStore.startWebLogin()"
        >
          <template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template>
        </Button>
      </div>

      <p class="qzl-footnote">
        <Lock :size="14" :stroke-width="1.8" aria-hidden="true" />
        <span>登录信息由系统凭据库保存，退出登录后清除。</span>
      </p>
    </div>

    <!-- ---------------------------------------------------------- 扫码模式 -->
    <div v-else class="qzl-body">
      <ol class="qzl-steps" aria-label="扫码登录步骤"><li><span>1</span>打开手机 QQ</li><li :class="{ 'is-current': qrState === 'waiting' }"><span>2</span>扫描二维码</li><li :class="{ 'is-current': qrState === 'scanned' }"><span>3</span>在手机确认</li></ol>
      <div class="qzl-stage" :class="`is-${qrState}`">
        <SkeletonBlock v-if="loading && !qrImage" width="100%" height="100%" />
        <img v-else-if="qrImage" :src="qrImage" alt="QQ 登录二维码" />
        <QrCode v-else :size="52" :stroke-width="1.6" aria-hidden="true" />

        <span v-if="qrState === 'scanned'" class="qzl-badge is-scanned">
          <CircleCheck :size="15" :stroke-width="1.8" aria-hidden="true" />
          <span>已扫码，请在手机确认</span>
        </span>
        <span v-else-if="qrState === 'expired'" class="qzl-badge is-expired">
          <Clock :size="15" :stroke-width="1.8" aria-hidden="true" />
          <span>二维码已过期</span>
        </span>
        <span v-else-if="qrState === 'error'" class="qzl-badge is-error">
          <CircleAlert :size="15" :stroke-width="1.8" aria-hidden="true" />
          <span>二维码获取失败</span>
        </span>
      </div>

      <div class="qzl-status" :class="`is-${qrState}`" role="status" aria-live="polite">
        <span class="qzl-status__dot" aria-hidden="true" />
        <p>{{ qrState === 'error' ? describeError(message, '二维码暂时没有获取成功，请重试。') : message }}</p>
      </div>

      <div class="qzl-actions">
        <Button
          v-if="qrState === 'expired' || qrState === 'idle'"
          :label="qrState === 'expired' ? '刷新二维码' : '获取二维码'"
          :loading="loading"
          @click="authStore.refreshQrCode"
        >
          <template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template>
        </Button>
        <Button
          v-else-if="qrState === 'error'"
          label="重试"
          severity="secondary"
          :loading="loading"
          @click="authStore.refreshQrCode"
        >
          <template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template>
        </Button>
      </div>

      <div v-if="showWebLogin" class="qzl-alt">
        <Button
          label="改用网页登录"
          severity="secondary"
          text
          size="small"
          :disabled="loading"
          @click="authStore.startWebLogin()"
        >
          <template #icon><ExternalLink :size="15" :stroke-width="1.8" /></template>
        </Button>
        <small>将在独立窗口打开 QQ 官方登录页</small>
      </div>

      <p class="qzl-footnote">
        <Lock :size="14" :stroke-width="1.8" aria-hidden="true" />
        <span>登录凭证只用于连接 QQ 空间。桌面端由系统凭据库保存，退出登录即可清除。</span>
      </p>
    </div>
  </Dialog>
</template>

<style scoped>
.qzl-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.qzl-brand__mark {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

/* 这里放全彩版（蓝笔画 + 琥珀碎片）：底色是浅蓝 tint，与官网导航同一套搭配。
   侧边栏那块是实心 --color-accent 底，所以那边用白笔画版本 —— 同一个标识两种底，
   各有各的正确画法。 */
.qzl-brand__logo {
  width: 22px;
  height: auto;
  display: block;
}

.qzl-brand__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.qzl-brand__copy strong {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}

.qzl-brand__copy small {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}

.qzl-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  max-height: min(520px, calc(100vh - var(--space-16) * 2));
  overflow-y: auto;
}

/* ------------------------------------------------------------------ 二维码 */

.qzl-stage {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  max-width: 224px;
  aspect-ratio: 1 / 1;
  padding: var(--space-3);
  overflow: hidden;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  /* 二维码必须保持恒定白底：跟随深色主题压暗会让部分手机扫不出来。 */
  --qzl-qr-canvas: #ffffff;
  background: var(--qzl-qr-canvas);
  transition: opacity var(--duration-base) var(--ease-out);
}

/* 骨架要撑满二维码位，否则百分比高度会在自适应高度的 flex 容器里塌陷。 */
.qzl-stage :deep(.qza-skeleton-stack) {
  align-self: stretch;
  height: 100%;
}

/* 白底画布上压淡骨架，避免深色主题下出现一块突兀的黑块。 */
.qzl-stage :deep(.qza-skeleton) {
  opacity: 0.35;
}

.qzl-stage img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: crisp-edges;
}

.qzl-stage > svg {
  color: var(--color-text-tertiary);
}

.qzl-stage.is-expired img,
.qzl-stage.is-error img {
  opacity: 0.16;
  filter: grayscale(1);
}

.qzl-stage.is-web {
  border-style: dashed;
  border-color: var(--color-border-strong);
  background: var(--color-surface-sunken);
}

.qzl-stage__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
}

.qzl-stage__placeholder small {
  font-size: var(--text-2xs);
}

.qzl-badge {
  position: absolute;
  left: 50%;
  bottom: var(--space-3);
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  max-width: calc(100% - var(--space-4) * 2);
  padding: var(--space-2) var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: 1.2;
  white-space: nowrap;
}

.qzl-badge.is-scanned {
  border-color: var(--color-success);
  background: var(--color-success-soft);
  color: var(--color-success);
}

.qzl-badge.is-expired {
  border-color: var(--color-warning);
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.qzl-badge.is-error {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* ------------------------------------------------------------------ 状态行 */

.qzl-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 22px;
  text-align: center;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.qzl-status p {
  margin: 0;
}

.qzl-status__dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-text-tertiary);
}

.qzl-status.is-waiting .qzl-status__dot {
  background: var(--color-accent);
  animation: qzl-pulse 1.6s ease-in-out infinite;
}

.qzl-status.is-scanned .qzl-status__dot {
  background: var(--color-success);
}

.qzl-status.is-expired .qzl-status__dot {
  background: var(--color-warning);
}

.qzl-status.is-error .qzl-status__dot {
  background: var(--color-danger);
}

@keyframes qzl-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.78);
  }
}

/* ------------------------------------------------------------ 操作与说明 */

.qzl-note {
  max-width: 34ch;
  text-align: center;
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.qzl-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  width: 100%;
}

.qzl-alt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding-top: var(--space-4);
  border-top: var(--line-width) solid var(--color-border);
}

.qzl-alt small {
  text-align: center;
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.qzl-footnote {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-1);
  padding-top: var(--space-3);
  border-top: var(--line-width) solid var(--color-border);
  text-align: center;
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}

.qzl-footnote svg {
  flex-shrink: 0;
}

@media (max-width: 860px) {
  .qzl-body {
    gap: var(--space-3);
  }

  .qzl-stage {
    max-width: 200px;
  }
}

.qzl-steps { list-style:none; display:flex; align-items:center; justify-content:center; gap:var(--space-4); margin:0; padding:var(--space-2) 0; width:100%; }
.qzl-steps li { display:flex; align-items:center; gap:var(--space-1); color:var(--color-text-secondary); font-size:var(--text-2xs); }
.qzl-steps span { display:grid; place-items:center; width:var(--space-5); height:var(--space-5); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-full); font-variant-numeric:tabular-nums; }
.qzl-steps .is-current { color:var(--color-accent); }
.qzl-steps .is-current span { background:var(--color-accent-soft); border-color:var(--color-accent-border); }
@media (max-width:400px) { .qzl-steps { gap:var(--space-2); } .qzl-body { max-height:none; } }

</style>
