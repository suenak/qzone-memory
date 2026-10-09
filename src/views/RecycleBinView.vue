<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";
import { platform } from "../utils/platform";
import { describeError } from "../utils/uiError";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { storeToRefs } from "pinia";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { X, RefreshCw, KeyRound, RotateCcw,
  Check,
  ChevronRight,
  CircleAlert,
  FolderOpen,
  ImageOff,
  Images,
  Info,
  Loader,
  Lock,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import ArchiveHeading from "../components/ui/ArchiveHeading.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import { isTauri } from "@tauri-apps/api/core";
import { useAuthStore } from "../stores/auth";
import { useRecycleSessionStore } from "../stores/recycle";
import { useToast } from "../composables/useToast";
import { syncCookiesToWebview } from "../utils/qlogin";
import { checkRecyclePassword, closeRecyclePasswordWindow, createQzoneAlbum, listQzoneAlbums, listRecycleAlbums, listRecyclePhotos, loadRecyclePhotoPreview, openRecyclePasswordWindow, prepareRecyclePasswordWindow, recoverRecycleAlbum, recoverRecyclePhotos } from "../utils/qzone";

interface Album { id: string; name: string; count: number }
interface Photo { id: string; sourceAlbumId: string; name: string; url?: string; deletedAt?: string }
const auth = useAuthStore();
const recycleSession = useRecycleSessionStore();
const { pwd2sig: token, ownerUin } = storeToRefs(recycleSession);
const verifying = ref(false);
const loading = ref(false);
const recovering = ref(false);
const error = ref("");
const albums = ref<Album[]>([]);
const photos = ref<Photo[]>([]);
const activeAlbumId = ref("");
const selectedIds = ref<string[]>([]);
const confirmVisible = ref(false);
const destinationMode = ref<"create" | "existing">("create");
const recoveryAlbumName = ref("恢复相册");
const destinationAlbums = ref<Album[]>([]);
const destinationAlbumId = ref("");
const destinationLoading = ref(false);
const destinationError = ref("");
const albumRecoverTarget = ref<Album | null>(null);
const albumRecovering = ref(false);
let verifyRun = 0;
let photoSequence = 0;
const verified = computed(() => Boolean(token.value));
const allSelected = computed(() => photos.value.length > 0 && selectedIds.value.length === photos.value.length);
const activeAlbum = computed(() => albums.value.find((item) => item.id === activeAlbumId.value));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const object = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
function values(response: Record<string, unknown>, names: string[]) {
  const data = object(response.data);
  for (const name of names) { const value = data[name] ?? response[name]; if (Array.isArray(value)) return value.map(object); }
  return [];
}
function field(item: Record<string, unknown>, names: string[]) {
  for (const name of names) if (item[name] != null) return String(item[name]);
  return "";
}
function mapAlbums(response: Record<string, unknown>): Album[] {
  return values(response, ["album", "albums", "albumList"]).map((item) => ({ id: field(item, ["albumid", "albumId", "id"]), name: field(item, ["name", "albumname", "title"]) || "未命名相册", count: Number(field(item, ["num", "photoNum", "total"]) || 0) })).filter((item) => item.id);
}
function mapPhotos(response: Record<string, unknown>, albumId: string): Photo[] {
  return values(response, ["photo", "photos", "photoList", "list"]).map((item) => ({ id: field(item, ["lloc", "photoId", "photoid", "id"]), sourceAlbumId: field(item, ["albumid", "albumId"]) || albumId, name: field(item, ["name", "photoName", "title"]) || "照片", url: field(item, ["pre", "url", "origin_url", "rawUrl"]) || undefined, deletedAt: field(item, ["modifytime", "deleteTime", "deltime"]) || undefined })).filter((item) => item.id);
}
function responseAlbumId(response: Record<string, unknown>) {
  const candidates = [response, object(response.data), object(object(response.data).album), object(response.album)];
  for (const candidate of candidates) {
    const id = field(candidate, ["albumid", "albumId", "id"]);
    if (id) return id;
  }
  return "";
}
async function loadPhotos(albumId = "") {
  const sequence = ++photoSequence;
  loading.value = true; error.value = ""; selectedIds.value = []; activeAlbumId.value = albumId;
  try {
    const mapped = mapPhotos(await listRecyclePhotos(token.value, albumId || undefined), albumId);
    if (sequence !== photoSequence) return;
    photos.value = mapped;
    const previews = await Promise.all(mapped.map(async (photo) => {
      if (!photo.url || photo.url.startsWith("data:")) return photo;
      try { return { ...photo, url: await loadRecyclePhotoPreview(photo.url) }; } catch { return photo; }
    }));
    if (sequence === photoSequence) photos.value = previews;
  }
  catch (reason) { if (sequence === photoSequence) error.value = String(reason); }
  finally { if (sequence === photoSequence) loading.value = false; }
}
async function loadAll() {
  loading.value = true; error.value = "";
  try { albums.value = mapAlbums(await listRecycleAlbums(token.value)); await loadPhotos(); }
  catch (reason) { error.value = String(reason); loading.value = false; }
}
async function verify() {
  if (!auth.loggedIn) { await auth.openLogin(); return; }
  const run = ++verifyRun; verifying.value = true; error.value = "";
  try {
    if (platform() === "macos") {
      // Creating this legacy QQ page from a Rust async command has caused
      // WKWebView process aborts on macOS. Let Tauri's JS window manager own
      // the window and keep the page free of injected scripts instead.
      const url = await prepareRecyclePasswordWindow();
      await syncCookiesToWebview();
      const existing = await WebviewWindow.getByLabel("qzone-recycle-auth");
      if (existing) await existing.close();
      const verificationWindow = new WebviewWindow("qzone-recycle-auth", {
        url, title: "验证 QQ 空间独立密码", width: 960, height: 720,
        minWidth: 560, minHeight: 520, center: true, focus: true,
      });
      await new Promise<void>((resolve, reject) => {
        void verificationWindow.once("tauri://created", () => resolve());
        void verificationWindow.once("tauri://error", (event) => reject(new Error(String(event.payload))));
      });
    } else {
      await openRecyclePasswordWindow();
    }
    while (run === verifyRun && verifying.value) {
      const result = await checkRecyclePassword();
      if (result) { recycleSession.setVerified(result, auth.user?.uin ?? ""); verifying.value = false; await closeRecyclePasswordWindow(); await loadAll(); return; }
      await delay(1200);
    }
  } catch (reason) { error.value = String(reason); verifying.value = false; }
}
/* 原来的全选逻辑合并进 toggleVisibleSelection（同一份 photos 列表），
 * 只作用域到当前列表，避免与「已选 N 张」的显示不一致。 */
async function openRecoverDialog() {
  destinationMode.value = "existing";
  recoveryAlbumName.value = "恢复相册";
  destinationError.value = "";
  confirmVisible.value = true;
  await selectDestinationMode("existing");
}
async function selectDestinationMode(mode: "create" | "existing") {
  destinationMode.value = mode;
  if (mode !== "existing" || destinationLoading.value || destinationAlbums.value.length) return;
  destinationError.value = "";
  destinationLoading.value = true;
  try {
    destinationAlbums.value = mapAlbums(await listQzoneAlbums());
    destinationAlbumId.value = destinationAlbums.value[0]?.id ?? "";
  } catch (reason) {
    destinationAlbums.value = [];
    destinationAlbumId.value = "";
    destinationError.value = `已有相册加载失败：${String(reason)}`;
  } finally {
    destinationLoading.value = false;
  }
}
async function recover() {
  if (recovering.value || !selectedIds.value.length) return;
  const groups = new Map<string, string[]>();
  for (const photo of photos.value.filter((item) => selectedIds.value.includes(item.id))) {
    const group = groups.get(photo.sourceAlbumId) ?? [];
    group.push(photo.id); groups.set(photo.sourceAlbumId, group);
  }
  recovering.value = true; error.value = "";
  try {
    let targetAlbumId = destinationAlbumId.value;
    if (destinationMode.value === "create") {
      const name = recoveryAlbumName.value.trim();
      if (!name) throw new Error("请输入新相册名称");
      const beforeAlbums = mapAlbums(await listQzoneAlbums());
      const previousIds = new Set(beforeAlbums.map((album) => album.id));
      const created = await createQzoneAlbum(name);
      targetAlbumId = "";
      for (let attempt = 0; attempt < 3 && !targetAlbumId; attempt += 1) {
        const refreshed = mapAlbums(await listQzoneAlbums());
        targetAlbumId = refreshed.find((album) => album.name === name && !previousIds.has(album.id))?.id ?? "";
        if (!targetAlbumId && attempt < 2) await delay(300 * (attempt + 1));
      }
      targetAlbumId ||= responseAlbumId(created);
      if (!targetAlbumId) throw new Error("相册已创建，但响应中缺少相册 ID，请刷新后重试");
      // 新相册会先出现在列表服务中，照片恢复服务通常还需要短暂同步。
      await delay(1800);
    } else if (!targetAlbumId) {
      throw new Error("请选择恢复目标相册");
    }
    for (const [sourceAlbumId, ids] of groups) {
      if (!sourceAlbumId) throw new Error("照片缺少回收站来源相册 ID");
      await recoverRecyclePhotos(token.value, sourceAlbumId, targetAlbumId, ids);
    }
    confirmVisible.value = false; await loadPhotos(activeAlbumId.value);
  }
  catch (reason) { error.value = String(reason); }
  finally { recovering.value = false; }
}
function openAlbumRecoverDialog(album: Album) { albumRecoverTarget.value = album; }
async function recoverAlbum() {
  if (!albumRecoverTarget.value || albumRecovering.value) return;
  albumRecovering.value = true; error.value = "";
  try {
    await recoverRecycleAlbum(token.value, albumRecoverTarget.value.id);
    albumRecoverTarget.value = null;
    await loadAll();
  } catch (reason) { error.value = String(reason); }
  finally { albumRecovering.value = false; }
}
function resetVerification() { photoSequence += 1; recycleSession.clear(); photos.value = []; albums.value = []; selectedIds.value = []; }
onMounted(() => {
  if (token.value && ownerUin.value === (auth.user?.uin ?? "")) void loadAll();
  else if (token.value) recycleSession.clear();
});
onBeforeUnmount(() => { verifyRun += 1; verifying.value = false; if (isTauri()) void closeRecyclePasswordWindow().catch(() => {}); });

/* ---------------------------------------------------------------------- UI 层
 * 以下全部是展示用状态，不触碰上面的业务逻辑：
 * 步骤指示、已加载标记、预览可见性、图片加载失败标记、危险操作二次确认。 */

const toast = useToast();
const visiblePhotoIds = ref(new Set<string>());
const failedPreviewIds = ref(new Set<string>());
const recoverConfirmed = ref(false);
/** 恢复是否成功结束：只在成功关闭弹窗后给一次提示。 */
const recoverSucceeded = ref(false);
let observer: IntersectionObserver | undefined;

/** 当前步骤：1 验证独立密码 → 2 选择内容 → 3 恢复。 */
const currentStep = computed(() => {
  if (!verified.value) return 1;
  if (selectedIds.value.length) return 3;
  return 2;
});

const stepSubtitle = computed(() => {
  if (currentStep.value === 1) {
    return auth.loggedIn
      ? "先在独立窗口里验证空间独立密码，验证通过后才会读取回收站内容。"
      : "先登录 QQ 空间，再验证空间独立密码。";
  }
  if (currentStep.value === 2) {
    return photos.value.length
      ? `当前有 ${photos.value.length} 张可恢复照片，先在「全部照片」里勾选要恢复的内容。`
      : "回收站暂时没有可恢复的内容。";
  }
  return `已选择 ${selectedIds.value.length} 张照片，确认目标相册后执行恢复。`;
});

const visiblePhotoIds$ = computed(() => photos.value.map((item) => item.id));

/** 预览仍在从 QQ 服务端取回：此时显示占位骨架，而不是空的图片框。 */
function photoPending(photo: Photo) {
  return !photo.url || /^https?:/i.test(photo.url);
}

function photoFailed(photo: Photo) {
  return failedPreviewIds.value.has(photo.id);
}

function markPreviewFailed(photo: Photo) {
  failedPreviewIds.value = new Set(failedPreviewIds.value).add(photo.id);
}

/** 只观察已经解析出真实图片地址的卡片，未解析的正由后端逐张取回。 */
function observeCards() {
  observer?.disconnect();
  if (typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver((entries) => {
    const next = new Set(visiblePhotoIds.value);
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.photoId;
      if (id) next.add(id);
    }
    visiblePhotoIds.value = next;
  }, { rootMargin: "240px 0px" });
  document.querySelectorAll<HTMLElement>(".photo-grid [data-photo-id]").forEach((element) => observer?.observe(element));
}

function toggleVisibleSelection() {
  const visible = new Set(visiblePhotoIds$.value);
  selectedIds.value = allSelected.value
    ? selectedIds.value.filter((id) => !visible.has(id))
    : [...new Set([...selectedIds.value, ...visible])];
}

function confirmWithRecover() {
  if (!recoverConfirmed.value || recovering.value) return;
  recoverSucceeded.value = false;
  void recover();
}

function openRecoverDialogGuarded() {
  error.value = "";
  recoverConfirmed.value = false;
  void openRecoverDialog();
}

function closeRecoverDialog() {
  confirmVisible.value = false;
  recoverConfirmed.value = false;
}

/** 业务函数 recover 关掉弹窗即代表成功，这里据此补一条可见反馈。 */
watch(recovering, (current, previous) => {
  if (previous && !current && !confirmVisible.value && !error.value) recoverSucceeded.value = true;
});

/** 弹窗真正收起后：给成功提示并复位二次确认勾选。 */
function onRecoverDialogHide() {
  recoverConfirmed.value = false;
  if (recoverSucceeded.value) {
    recoverSucceeded.value = false;
    toast.success("照片已提交恢复，可从回收站列表确认结果。");
  }
}

function openAlbumRecoverDialogGuarded(album: Album) {
  error.value = "";
  openAlbumRecoverDialog(album);
}

async function confirmAlbumRecover() {
  await recoverAlbum();
  if (!albumRecoverTarget.value) toast.success("整个相册已恢复，可从回收站列表确认结果。");
}

function closeAlbumDialog() {
  if (!albumRecovering.value) albumRecoverTarget.value = null;
}

function handleAuthError() {
  verify();
}

/** 后端错误前缀化成人话：说明发生了什么，再给出可执行的下一步。 */
function friendlyError(reason: string) {
  if (!reason) return "";
  if (/密码|password|pwd/i.test(reason)) return "独立密码验证失败，请重新验证。";
  if (/登录|login|cookie/i.test(reason)) return "登录状态可能已失效，请重新登录 QQ 空间后再试。";
  return describeError(reason, "操作没有完成，可以先点「刷新」重试一次。");
}

function formatDeletedAt(value?: string) {
  if (!value) return "";
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false })
    : value;
}

onMounted(() => {
  // 页面进入时若已有验证签名，业务侧的 onMounted 会加载数据；这里只负责接入观察器。
  observeCards();
});
// 照片列表每次重绘后重新观察（预览是逐张异步解析出来的）。
onUpdated(() => { observeCards(); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="recycle-page">
    <ArchiveHeading title="相册回收站" description="查看 QQ 空间回收站，将可恢复的照片恢复到空间相册。" :icon="Images" />
    <!-- ---------------------------------------------------------- 步骤条 -->
    <ol class="stepper" aria-label="回收站恢复步骤">
      <li class="stepper__item" :class="{ 'is-active': currentStep === 1, 'is-done': currentStep > 1 }">
        <span class="stepper__index"><Check v-if="currentStep > 1" :size="14" :stroke-width="2.2" /><template v-else>1</template></span>
        <span class="stepper__copy">
          <strong>验证独立密码</strong>
          <small>{{ currentStep === 1 ? "当前步骤" : "已完成" }}</small>
        </span>
      </li>
      <ChevronRight class="stepper__arrow" :size="15" :stroke-width="1.8" aria-hidden="true" />
      <li class="stepper__item" :class="{ 'is-active': currentStep === 2, 'is-done': currentStep > 2 }">
        <span class="stepper__index"><Check v-if="currentStep > 2" :size="14" :stroke-width="2.2" /><template v-else>2</template></span>
        <span class="stepper__copy">
          <strong>选择要恢复的照片</strong>
          <small>{{ verified ? `${photos.length} 张可恢复` : "等待验证" }}</small>
        </span>
      </li>
      <ChevronRight class="stepper__arrow" :size="15" :stroke-width="1.8" aria-hidden="true" />
      <li class="stepper__item" :class="{ 'is-active': currentStep === 3 }">
        <span class="stepper__index">3</span>
        <span class="stepper__copy">
          <strong>恢复到相册</strong>
          <small>{{ selectedIds.length ? `已选 ${selectedIds.length} 张` : "尚未选择" }}</small>
        </span>
      </li>
    </ol>

    <!-- ------------------------------------------------- 第 1 步：验证密码 -->
    <SectionCard
      v-if="!verified"
      title="验证 QQ 空间独立密码"
      description="请在 QQ 空间窗口中验证独立密码，本应用不会读取或保存该密码。"
    >
      <div class="auth-state">
        <span class="auth-state__icon" aria-hidden="true">
          <Lock :size="24" :stroke-width="1.8" />
        </span>
        <div class="auth-state__copy">
          <strong>{{ auth.loggedIn ? "验证通过后即可读取回收站内容" : "先登录 QQ 空间" }}</strong>
          <p v-if="auth.loggedIn">验证独立密码后，本页会自动加载回收站。</p>
          <p v-else>先登录 QQ 空间，再验证独立密码。</p>
        </div>
        <div class="auth-state__actions">
          <Button
            :label="verifying ? '等待验证完成…' : (auth.loggedIn ? '验证独立密码' : '先登录 QQ 空间')"

            :loading="verifying"
            @click="verify"
          ><template #icon><ShieldCheck :size="16" :stroke-width="1.8" /></template></Button>
          <Button v-if="verifying" label="停止等待" severity="secondary" text @click="verifying = false" ><template #icon><X :size="16" :stroke-width="1.8" /></template></Button>
        </div>
      </div>

      <p v-if="verifying" class="inline-hint">
        <Loader :size="14" :stroke-width="1.8" aria-hidden="true" />
        请在弹出窗口完成验证，成功后本页会自动加载回收站内容。
      </p>

      <div v-if="error" class="error-banner">
        <CircleAlert :size="16" :stroke-width="1.8" aria-hidden="true" />
        <span>{{ friendlyError(error) }}</span>
        <Button label="重试" size="small" severity="secondary" outlined @click="handleAuthError" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
      </div>

      <template #footer>
        <p class="footer-note">
          <ShieldCheck :size="15" :stroke-width="1.8" aria-hidden="true" />
          验证仅在本次使用期间有效，关闭应用或退出登录后需重新验证。
        </p>
      </template>
    </SectionCard>

    <!-- ------------------------------------- 第 2 / 3 步：浏览、选择、恢复 -->
    <template v-else>
      <SectionCard
        title="相册回收站"
        :description="stepSubtitle"
      >
        <template #actions>
          <Button label="重新验证" severity="secondary" text size="small" @click="resetVerification" ><template #icon><KeyRound :size="16" :stroke-width="1.8" /></template></Button>
          <Button label="刷新" severity="secondary" text size="small" :loading="loading" @click="loadAll" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
        </template>

        <div class="toolbar">
          <span class="count-chip">
            <Images :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ photos.length }} 张可恢复照片
            <template v-if="activeAlbum"> · {{ activeAlbum.name }}</template>
          </span>
          <div class="toolbar__actions">
            <Button
              v-if="activeAlbum"
              label="恢复整个相册"

              :loading="albumRecovering"
              :disabled="albumRecovering"
              @click="openAlbumRecoverDialogGuarded(activeAlbum)"
            ><template #icon><FolderOpen :size="16" :stroke-width="1.8" /></template></Button>
            <Button
              v-else
              :label="`恢复所选 (${selectedIds.length})`"

              :disabled="!selectedIds.length"
              @click="openRecoverDialogGuarded"
            ><template #icon><RotateCcw :size="16" :stroke-width="1.8" /></template></Button>
          </div>
        </div>

        <div v-if="error" class="error-banner">
          <CircleAlert :size="16" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ friendlyError(error) }}</span>
          <Button label="刷新重试" size="small" severity="secondary" outlined @click="loadAll" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
        </div>
      </SectionCard>

      <div class="recycle-layout">
        <!-- 回收站相册列表 -->
        <SectionCard flush class="album-panel">
          <nav class="album-list" aria-label="回收站相册">
            <button
              type="button"
              class="album-item"
              :class="{ 'is-active': !activeAlbumId }"
              @click="loadPhotos()"
            >
              <span class="album-item__icon" aria-hidden="true"><Images :size="18" :stroke-width="1.8" /></span>
              <span class="album-item__copy">
                <strong>全部照片</strong>
                <small>回收站内所有相册</small>
              </span>
            </button>
            <button
              v-for="album in albums"
              :key="album.id"
              type="button"
              class="album-item"
              :class="{ 'is-active': activeAlbumId === album.id }"
              @click="loadPhotos(album.id)"
            >
              <span class="album-item__icon" aria-hidden="true"><FolderOpen :size="18" :stroke-width="1.8" /></span>
              <span class="album-item__copy">
                <strong>{{ album.name }}</strong>
                <small>{{ album.count ? `${album.count} 张` : "回收站相册" }}</small>
              </span>
            </button>
          </nav>
        </SectionCard>

        <!-- 照片区域 -->
        <SectionCard flush class="photo-panel">
          <div v-if="activeAlbum" class="mode-notice">
            <Info :size="18" :stroke-width="1.8" aria-hidden="true" />
            <div>
              <strong>恢复整个相册</strong>
              <span>QQ 空间只支持把回收站相册整体恢复。若想把单张照片恢复到指定相册，请切换到「全部照片」。</span>
            </div>
            <Button label="查看全部照片" severity="secondary" size="small" @click="loadPhotos()" />
          </div>

          <div class="photo-body">
            <div v-if="loading" class="photo-grid" aria-busy="true">
              <div v-for="index in 6" :key="index" class="photo-card is-skeleton">
                <span class="photo-card__media">
                  <SkeletonBlock width="100%" height="100%" />
                </span>
                <span class="photo-card__copy">
                  <SkeletonBlock width="70%" height="11px" />
                  <SkeletonBlock width="46%" height="10px" />
                </span>
              </div>
            </div>

            <template v-else-if="!photos.length">
              <EmptyState
                :icon="activeAlbum ? ImageOff : Trash2"
                title="回收站里没有可恢复的内容"
                :description="activeAlbum
                  ? '这个回收站相册已经空了。切回「全部照片」看看其他相册，或点「刷新」重新读取。'
                  : 'QQ 空间暂未返回可恢复内容，已超过保留期的照片可能无法找回。'"
              >
                <Button label="刷新" severity="secondary" outlined size="small" :loading="loading" @click="loadAll" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
              </EmptyState>
            </template>

            <template v-else>
              <div v-if="!activeAlbum" class="select-row">
                <Checkbox
                  :model-value="allSelected"
                  binary
                  input-id="select-all-recycle"
                  @update:model-value="toggleVisibleSelection"
                />
                <label for="select-all-recycle">全选当前照片（{{ photos.length }} 张）</label>
                <span v-if="selectedIds.length" class="select-row__count">已选 {{ selectedIds.length }} 张</span>
              </div>

              <div class="photo-grid">
                <label
                  v-for="photo in photos"
                  :key="photo.id"
                  class="photo-card"
                  :class="{ 'is-selected': selectedIds.includes(photo.id), 'is-selectable': !activeAlbum }"
                  :data-photo-id="photo.id"
                >
                  <span class="photo-card__media">
                    <img
                      v-if="photo.url && !photoFailed(photo)"
                      :src="photo.url"
                      :alt="photo.name"
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @error="markPreviewFailed(photo)"
                    />
                    <span v-else-if="photoPending(photo) && visiblePhotoIds.has(photo.id)" class="photo-card__placeholder">
                      <SkeletonBlock width="100%" height="100%" />
                    </span>
                    <span v-else class="photo-card__placeholder is-fallback">
                      <ImageOff :size="20" :stroke-width="1.8" aria-hidden="true" />
                      <small>{{ photoFailed(photo) ? "预览加载失败" : "正在取回预览" }}</small>
                    </span>
                  </span>

                  <span v-if="!activeAlbum" class="photo-card__check" aria-hidden="true">
                    <Checkbox v-model="selectedIds" :value="photo.id" :input-id="`recycle-photo-${photo.id}`" />
                  </span>

                  <span class="photo-card__copy">
                    <strong>{{ photo.name }}</strong>
                    <small v-if="photo.deletedAt">删除于 {{ formatDeletedAt(photo.deletedAt) }}</small>
                  </span>
                </label>
              </div>
            </template>
          </div>
        </SectionCard>
      </div>
    </template>

    <!-- ------------------------------------------------ 单张照片恢复确认 -->
    <Dialog
      v-model:visible="confirmVisible"
      modal
      :closable="!recovering"
      :close-on-escape="!recovering"
      :draggable="false"
      class="recycle-recover-dialog"
      header="恢复照片"
      @hide="onRecoverDialogHide"
    >
      <div class="dialog-alert">
        <span class="dialog-alert__icon" aria-hidden="true"><TriangleAlert :size="18" :stroke-width="1.8" /></span>
        <div>
          <strong>将把 {{ selectedIds.length }} 张照片恢复到 QQ 空间相册</strong>
          <p>恢复后这些照片会从回收站移除，并出现在你选择的相册里。恢复前请核对照片数量和目标相册。</p>
        </div>
      </div>

      <div class="dialog-tabs" role="tablist" aria-label="恢复目标">
        <button
          type="button"
          role="tab"
          :aria-selected="destinationMode === 'create'"
          :class="{ 'is-active': destinationMode === 'create' }"
          @click="selectDestinationMode('create')"
        >
          新建相册
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="destinationMode === 'existing'"
          :class="{ 'is-active': destinationMode === 'existing' }"
          @click="selectDestinationMode('existing')"
        >
          已有相册
        </button>
      </div>

      <div v-if="destinationMode === 'create'" class="dialog-field">
        <label for="recovery-album-name">相册名称</label>
        <InputText id="recovery-album-name" v-model="recoveryAlbumName" maxlength="30" fluid />
        <small>新建相册为公开相册，所有人可见。</small>
      </div>
      <div v-else class="dialog-field">
        <label for="recovery-album-select">目标相册</label>
        <SkeletonBlock v-if="destinationLoading" width="100%" height="38px" />
        <template v-else>
          <Select
            id="recovery-album-select"
            v-model="destinationAlbumId"
            :options="destinationAlbums"
            option-label="name"
            option-value="id"
            :disabled="!destinationAlbums.length"
            placeholder="请选择相册"
            fluid
          />
          <small v-if="!destinationAlbums.length">暂无可选相册，可以切回「新建相册」。</small>
        </template>
        <span v-if="destinationError" class="dialog-error">{{ friendlyError(destinationError) }}</span>
      </div>

      <label class="dialog-confirm">
        <Checkbox v-model="recoverConfirmed" binary :disabled="recovering" />
        <span>我已确认照片数量和目标相册。</span>
      </label>
      <p v-if="error" class="dialog-error" role="alert">{{ describeError(error, '恢复未完成，请核对回收站和目标相册后重试。') }}</p>

      <template #footer>
        <Button label="取消" severity="secondary" text :disabled="recovering" @click="closeRecoverDialog" />
        <Button
          label="确认恢复"

          :loading="recovering"
          :disabled="!recoverConfirmed || destinationLoading || (destinationMode === 'existing' ? !destinationAlbumId : !recoveryAlbumName.trim())"
          @click="confirmWithRecover"
        ><template #icon><RotateCcw :size="16" :stroke-width="1.8" /></template></Button>
      </template>
    </Dialog>

    <!-- ---------------------------------------------------- 整册恢复确认 -->
    <Dialog
      :visible="Boolean(albumRecoverTarget)"
      modal
      :closable="!albumRecovering"
      :close-on-escape="!albumRecovering"
      :draggable="false"
      header="恢复整个相册？"
      @update:visible="(visible: boolean) => { if (!visible) closeAlbumDialog(); }"
    >
      <div class="dialog-alert is-warning">
        <span class="dialog-alert__icon" aria-hidden="true"><TriangleAlert :size="18" :stroke-width="1.8" /></span>
        <div>
          <strong>将恢复回收站相册「{{ albumRecoverTarget?.name }}」中的全部内容</strong>
          <p>
            影响范围：该相册{{ albumRecoverTarget?.count ? `约 ${albumRecoverTarget.count} 张` : "内全部" }}照片会一起恢复到 QQ 空间，
            恢复后整个相册会从回收站移除。此操作无法撤销。
          </p>
        </div>
      </div>
      <p class="dialog-note">
        如果只想恢复其中几张，请先切到「全部照片」，用勾选的方式挑选后再恢复。
      </p>
      <p v-if="error" class="dialog-error" role="alert">{{ describeError(error, '相册恢复失败，请重试。') }}</p>

      <template #footer>
        <Button label="取消" severity="secondary" text :disabled="albumRecovering" @click="closeAlbumDialog" />
        <Button label="确认恢复相册" :loading="albumRecovering" @click="confirmAlbumRecover" ><template #icon><FolderOpen :size="16" :stroke-width="1.8" /></template></Button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.recycle-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

/* -------------------------------------------------------------- 步骤条 */

.stepper {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  list-style: none;
  flex-wrap: wrap; padding:var(--space-4); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-lg); background:var(--color-surface);
}

.stepper__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-tertiary);
  min-width: 0;
}

.stepper__index {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
}

.stepper__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.stepper__copy strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.stepper__copy small {
  font-size: var(--text-2xs);
  white-space: nowrap;
}

.stepper__item.is-active {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.stepper__item.is-active .stepper__index {
  background: var(--color-accent);
  color: var(--color-text-inverse);
}

.stepper__item.is-active strong {
  color: var(--color-accent);
}

.stepper__item.is-done .stepper__index {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.stepper__arrow {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

/* ------------------------------------------------------------ 验证阶段 */

.auth-state {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.auth-state__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 52px;
  height: 52px;
  border-radius: var(--radius-lg);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.auth-state__copy {
  flex: 1;
  min-width: 0;
}

.auth-state__copy strong {
  display: block;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.auth-state__copy p {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.auth-state__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.inline-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.footer-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.footer-note svg {
  flex-shrink: 0;
  color: var(--color-success);
}

/* ------------------------------------------------------------ 工具栏 */

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.count-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.error-banner span {
  flex: 1;
  min-width: 0;
}

.error-banner svg {
  flex-shrink: 0;
}

/* -------------------------------------------------------------- 布局 */

.recycle-layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
  min-width: 0;
}

.album-panel,
.photo-panel {
  min-width: 0;
}

.album-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
}

.album-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: var(--line-width) solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  transition: background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.album-item:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}

.album-item.is-active {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.album-item__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: inherit;
}

.album-item.is-active .album-item__icon {
  background: var(--color-surface);
}

.album-item__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.album-item__copy strong {
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.album-item__copy small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

/* ------------------------------------------------------------ 照片区域 */

.photo-body {
  padding: var(--density-card-padding, var(--space-5));
  min-width: 0;
}

.mode-notice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--line-width) solid var(--color-border);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-wrap: wrap;
}

.mode-notice > svg {
  flex-shrink: 0;
}

.mode-notice > div {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}

.mode-notice strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.mode-notice span {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.select-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  flex-wrap: wrap;
}

.select-row__count {
  margin-left: auto;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr));
  gap: var(--space-3);
  min-width: 0;
}

.photo-card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.photo-card.is-selectable {
  cursor: pointer;
}

.photo-card.is-selected {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-focus);
}

.photo-card__media {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  background: var(--color-surface-sunken);
  overflow: hidden;
}

.photo-card__media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-card__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  color: var(--color-text-tertiary);
  font-size: var(--text-2xs);
  text-align: center;
  padding: var(--space-2);
}

.photo-card__placeholder.is-fallback {
  background: var(--color-surface-sunken);
}

/* 骨架卡片：让微光块正好铺满方形预览位。 */
.photo-card.is-skeleton .photo-card__media .qza-skeleton-stack {
  height: 100%;
  gap: 0;
}

.photo-card.is-skeleton .photo-card__media .qza-skeleton {
  height: 100% !important;
  border-radius: 0;
}

.photo-card__check {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  display: grid;
  place-items: center;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
}

.photo-card__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
}

.photo-card__copy strong {
  overflow: hidden;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.photo-card__copy small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.photo-card.is-skeleton {
  border-style: dashed;
}

.photo-card.is-skeleton .photo-card__copy {
  gap: var(--space-1);
}

/* -------------------------------------------------------------- 弹窗 */

.dialog-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
}

.dialog-alert__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-danger);
}

.dialog-alert strong {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.dialog-alert p {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.dialog-alert.is-warning {
  background: var(--color-warning-soft);
}

.dialog-alert.is-warning .dialog-alert__icon {
  color: var(--color-warning);
}

.dialog-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: var(--space-4) 0;
}

.dialog-tabs button {
  padding: var(--space-2) var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  transition: border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.dialog-tabs button:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.dialog-tabs button.is-active {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: var(--weight-medium);
}

.dialog-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.dialog-field label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.dialog-field small {
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}

.dialog-error {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-danger);
}

.dialog-confirm {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.dialog-confirm > span {
  flex: 1;
  min-width: 0;
}

.dialog-note {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}

/* ------------------------------------------------------------ 响应式 */

@media (max-width: 1080px) {
  .recycle-layout {
    grid-template-columns: 200px minmax(0, 1fr);
  }
}

@media (max-width: 860px) {
  .recycle-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .album-list {
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: var(--space-2);
  }

  .album-item {
    flex: 0 0 200px;
  }

  .stepper__arrow {
    display: none;
  }

  .stepper {
    gap: var(--space-1);
  }

  .stepper__item {
    flex: 1 1 0;
    justify-content: center;
  }

  .stepper__copy small {
    display: none;
  }

  .auth-state {
    align-items: flex-start;
    flex-direction: column;
  }

  .auth-state__actions {
    width: 100%;
  }

  .auth-state__actions > .p-button {
    flex: 1 1 auto;
    min-width: 0;
  }

  .photo-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr));
  }

  .toolbar,
  .toolbar__actions {
    align-items: stretch;
  }

  .toolbar__actions > .p-button {
    width: 100%;
  }
}

@media (max-width: 560px) {
  .stepper__copy strong {
    font-size: var(--text-xs);
    white-space: normal;
  }

  .select-row {
    justify-content: flex-start;
  }

  .select-row__count {
    margin-left: 0;
  }
}
@media (max-width:860px) { .album-list { max-height:calc(var(--space-16) * 3); overflow:auto; } }

</style>
