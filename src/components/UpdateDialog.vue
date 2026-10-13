<script setup lang="ts">
import { computed } from "vue";
import { platform } from "@tauri-apps/plugin-os";
import { ArrowDownToLine, Check, FolderOpen, Info } from "lucide-vue-next";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import ProgressBar from "primevue/progressbar";
import { useUpdateStore } from "../stores/update";
import { useArchiveStore } from "../stores/archive";
const update = useUpdateStore();
const archive = useArchiveStore();
let devicePlatform = "";
try { devicePlatform = platform(); } catch { /* browser preview */ }
const mobile = devicePlatform === "android" || devicePlatform === "ios";
const bytes = (value?: number) => value == null ? "" : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const percentage = computed(() => update.progress?.total ? Math.min(100, Math.floor(update.progress.downloaded / update.progress.total * 100)) : null);
const labels: Record<string, string> = { "windows-x86_64": "Windows", "darwin-aarch64": "macOS · Apple 芯片", "darwin-x86_64": "macOS · Intel", android: "Android" };
const platformLabel = computed(() => labels[update.available?.download?.platform ?? ""] ?? "当前设备");
const canRetry = computed(() => ["error", "cancelled"].includes(update.progress?.status ?? ""));
</script>

<template>
  <Dialog v-model:visible="update.dialogVisible" modal :draggable="false" header="应用更新" class="update-dialog">
    <div class="update-version">
      <span class="update-symbol"><Check v-if="update.downloaded" :size="24" :stroke-width="1.8" /><ArrowDownToLine v-else :size="24" :stroke-width="1.8" /></span>
      <div><h3>v{{ update.available?.version }}</h3><p>{{ update.downloaded ? '安装包已下载' : '有新版本可以更新' }}</p></div>
    </div>
    <div v-if="update.available?.notes" class="update-notes"><h4>更新内容</h4><p>{{ update.available.notes }}</p></div>
    <div v-if="update.available?.download" class="update-package">
      <div class="update-package__meta"><strong>{{ platformLabel }} 安装包</strong><span>{{ bytes(update.progress?.total ?? update.available.download.size) }}</span></div>
      <small>{{ update.progress?.fileName || update.available.download.fileName }}</small>
      <template v-if="update.downloading">
        <ProgressBar :value="percentage ?? undefined" :mode="percentage === null ? 'indeterminate' : 'determinate'" :show-value="false" :aria-label="update.progress?.message" />
        <div class="update-package__meta" role="status" aria-live="polite"><span>{{ update.progress?.message }}</span><span>{{ bytes(update.progress?.downloaded) }}{{ percentage === null ? '' : ` · ${percentage}%` }}</span></div>
      </template>
      <p v-else-if="update.progress" class="update-result" :class="{ 'is-error': update.progress.status === 'error' }" role="status">{{ update.progress.message }}</p>
    </div>
    <p v-else class="update-feedback" role="status">{{ update.available?.downloadError || '当前平台暂未提供安装包，可以打开下载页查看。' }}</p>
    <p v-if="update.actionError" class="update-feedback is-error" role="alert">{{ update.actionError }}</p>
    <p class="update-hint"><Info :size="15" :stroke-width="1.8" /><span>{{ update.downloaded && archive.busy ? '恢复或同步任务正在运行，请先停止任务再安装。' : devicePlatform === 'android' ? '下载完成后按系统提示安装。首次安装更新可能需要允许拾忆安装应用。' : '下载完成后打开安装包，按系统提示完成更新。' }}</span></p>
    <template #footer>
      <div class="update-actions">
        <Button v-if="update.downloaded && !mobile" text severity="secondary" size="small" @click="update.showPackage"><FolderOpen :size="16" :stroke-width="1.8" />打开文件夹</Button>
        <Button v-else text severity="secondary" size="small" label="官网下载" @click="update.goToDownloadPage" />
        <div class="update-actions__primary">
          <Button text severity="secondary" size="small" :label="update.downloading ? '后台下载' : '稍后再说'" @click="update.dialogVisible = false" />
          <Button v-if="update.downloading" outlined severity="secondary" size="small" label="取消下载" @click="update.cancelDownload" />
          <Button v-if="!update.downloading && (update.progress?.status === 'error' || !update.available?.download)" outlined severity="secondary" size="small" label="重新检查" :loading="update.checking" @click="update.check()" />
          <Button v-if="!update.downloading && update.downloaded" size="small" label="打开安装包" :loading="update.opening" :disabled="archive.busy" @click="update.openPackage" />
          <Button v-else-if="!update.downloading && update.available?.download" size="small" :label="canRetry ? '重新下载' : '下载安装包'" @click="update.download" />
        </div>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.update-version { display:flex; align-items:center; gap:var(--space-4); margin-bottom:var(--space-5); }
.update-symbol { display:grid; place-items:center; padding:var(--space-3); color:var(--color-accent); background:var(--color-accent-soft); border-radius:var(--radius-lg); }
.update-version h3 { font-size:var(--text-xl); font-weight:var(--weight-semibold); color:var(--color-text); }
.update-version p, .update-hint { color:var(--color-text-secondary); font-size:var(--text-sm); line-height:var(--leading-relaxed); }
.update-notes { margin-bottom:var(--space-5); }
.update-notes h4 { font-size:var(--text-sm); margin-bottom:var(--space-2); }
.update-notes p { white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--text-sm); line-height:var(--leading-relaxed); }
.update-package { display:grid; gap:var(--space-2); padding:var(--space-4); background:var(--color-surface-sunken); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); }
.update-package__meta { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--space-2); font-size:var(--text-sm); }
.update-package small { color:var(--color-text-secondary); font-size:var(--text-xs); overflow-wrap:anywhere; }
.update-package :deep(.p-progressbar) { height:var(--space-2); margin-top:var(--space-2); }
.update-result, .update-feedback { font-size:var(--text-sm); line-height:var(--leading-relaxed); overflow-wrap:anywhere; }
.is-error { color:var(--color-danger); }
.update-hint { display:flex; align-items:flex-start; gap:var(--space-2); margin-top:var(--space-4); }
.update-hint svg { flex-shrink:0; margin-top:var(--space-1); }
.update-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--space-2); width:100%; }
.update-actions__primary { display:flex; flex-wrap:wrap; gap:var(--space-2); }
.update-actions :deep(.p-button) { min-height:var(--touch-target); }
:global(.update-dialog) { width:min(94vw, var(--layout-detail-width)); }
@media (max-width:600px) { .update-actions { flex-direction:column-reverse; align-items:stretch; } .update-actions__primary { justify-content:flex-end; } }
</style>

