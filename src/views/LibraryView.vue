<script setup lang="ts">
import ImageViewer from "../components/ImageViewer.vue";
import Dialog from "primevue/dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { describeError, diagnosticError } from "../utils/uiError";
import { useAuthStore } from "../stores/auth";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import InputText from "primevue/inputtext";
import Paginator, { type PageState } from "primevue/paginator";
import Select from "primevue/select";
import {
  ArrowLeft,
  Bookmark,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
} from "lucide-vue-next";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import { useToast } from "../composables/useToast";
import { loadRemoteImageBlob, mediaFileName } from "../utils/archiveImage";
import {
  loadLibraryMedia,
  linkLibraryVideo,
  listQzoneLibrary,
  listQzoneLibraryYears,
  syncQzoneLibrary,
  type LibraryItem,
  type LibraryModule,
  type LibraryPage,
} from "../utils/qzone";

const route = useRoute();
const router = useRouter();
const items = ref<LibraryItem[]>([]);
const page = ref<LibraryPage>();
const years = ref<number[]>([]);
const selectedYear = ref(0);
const query = ref("");
const first = ref(0);
const pageSize = ref(24);
const loading = ref(false);
const syncing = ref(false);
const error = ref("");
const notice = ref("");
const imageSources = reactive<Record<number, string>>({});
const failedGuestbookAvatars = reactive(new Set<number>());
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let loadSequence = 0;

/* ------------------------------------------------------------------ 纯 UI 状态
 * 以下三段只服务于呈现：加载中的封面、灯箱索引、提示文案。
 * 不参与任何 Tauri 调用，也不改变上面的取数流程。 */

const toast = useToast();
const authStore = useAuthStore();
const expandedEntries = reactive(new Set<number>());
/** 正在取封面的条目，用来区分「还没取到」和「取不到」。 */
const coverLoading = reactive(new Set<number>());
/** 灯箱当前位置，-1 表示未打开。 */
const lightboxIndex = ref(-1);

const module = computed(() => String(route.meta.module || "albums") as LibraryModule);
const parentKey = computed(() => typeof route.params.albumId === "string" ? route.params.albumId : undefined);
const albumTitle = computed(() => typeof route.query.title === "string" ? route.query.title : "相册照片");

/**
 * 五个模块共用一套骨架，差异只体现在标题、图标、空状态与网格形态上。
 * 每个模块的 action / description 与后端语义一一对应，改动前请先看 qzone.ts。
 */
const moduleInfo = computed(() => ({
  albums: {
    title: "相册",
    kicker: "QQ 空间相册",
    icon: Images,
    description: "先备份相册列表，再打开相册备份照片。",
    action: "备份相册列表",
    emptyTitle: "还没有保存相册",
    emptyHint: "点击「备份相册列表」，读取当前可访问的相册。",
  },
  photos: {
    title: albumTitle.value,
    kicker: "相册照片",
    icon: ImageIcon,
    description: "打开照片时会优先保存原图，已保存的照片可离线查看。",
    action: "备份此相册",
    emptyTitle: "这个相册还没有照片",
    emptyHint: "点击「备份此相册」，读取当前可访问的照片。",
  },
  videos: {
    title: "视频",
    kicker: "QQ 空间视频",
    icon: Film,
    description: "保存视频列表，点击视频可在应用内播放。",
    action: "备份视频",
    emptyTitle: "还没有备份视频",
    emptyHint: "点击「备份视频」读取视频列表。播放地址过期时会尝试刷新。",
  },
  guestbook: {
    title: "留言板",
    kicker: "QQ 空间留言",
    icon: Mail,
    description: "查看当前留言，以及从历史互动中找到的留言。",
    action: "备份留言",
    emptyTitle: "还没有保存留言",
    emptyHint: "点击「备份留言」读取留言；备份说说时找到的历史留言也会列在这里。",
  },
  favorites: {
    title: "QQ 空间收藏",
    kicker: "QQ 空间收藏",
    icon: Bookmark,
    description: "保存 QQ 空间网页端的收藏，不包含手机 QQ 的通用收藏。",
    action: "备份空间收藏",
    emptyTitle: "还没有空间收藏",
    emptyHint: "点击「备份空间收藏」读取 QQ 空间网页端收藏。",
  },
}[module.value]));

const yearOptions = computed(() => [{ label: "全部年份", value: 0 }, ...years.value.map((year) => ({ label: `${year} 年`, value: year }))]);

/** 备份状态来自 LibraryPage 的真实字段：complete / syncedAt / lastError。 */
const syncState = computed(() => {
  const value = page.value;
  if (!value?.syncedAt) {
    return { tone: "idle", text: "尚未备份", detail: "点击备份从 QQ 空间读取", icon: CircleAlert };
  }
  const detail = `已保存 ${value.total} 条${value.remoteTotal ? ` / QQ 空间返回 ${value.remoteTotal} 条` : ""}`;
  if (value.lastError) {
    return { tone: "warning", text: "上次备份未完成", detail, icon: CircleAlert };
  }
  if (value.complete) {
    return { tone: "success", text: "本轮备份完成", detail, icon: CircleCheck };
  }
  return { tone: "warning", text: "备份未完成", detail: `${detail}，可继续备份`, icon: CircleAlert };
});

const formatTime = (seconds: number) => seconds
  ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000))
  : "时间未保留";
const syncedTime = computed(() => page.value?.syncedAt ? formatTime(page.value.syncedAt) : "—");
const guestbookAvatarUrl = (uin?: string) => uin ? `https://qlogo2.store.qq.com/qzone/${uin}/${uin}/100` : "";
const guestbookInitial = (item: LibraryItem) => (item.authorName || item.title || "留").slice(0, 1);

const hasFilter = computed(() => query.value.trim() !== "" || selectedYear.value !== 0);
const emptyTitle = computed(() => {
  if (error.value) return "内容读取失败";
  if (hasFilter.value) return "没有符合条件的内容";
  return moduleInfo.value.emptyTitle;
});
const emptyHint = computed(() => {
  if (error.value) return "请重试，已保存的内容会保留。";
  if (hasFilter.value) return "换个关键词，或把年份切回「全部年份」再看看。";
  return moduleInfo.value.emptyHint;
});
const skeletonCount = computed(() => (module.value === "photos" ? 12 : 9));

/** 后端错误串翻译成人话，原始串折叠在「详细原因」里供排查。 */
const errorText = computed(() => {
  const raw = error.value;
  if (!raw) return "";
  if (/登录|凭证|cookie|会话/i.test(raw)) return "QQ 空间的登录状态可能已经失效，重新登录后再试。";
  if (/限流|频繁|稍后|安全/i.test(raw)) return "请求过于频繁，请稍后再备份。";
  if (/网络|超时|连接|timeout/i.test(raw)) return "网络请求没有成功，检查网络后重试。";
  return "读取失败，请重试。已保存的内容会保留。";
});

interface PreviewEntry {
  id: number;
  item: LibraryItem;
  title: string;
  meta: string;
  summary: string;
}

/** 灯箱只收录有封面图的内容：留言板是纯文本，不参与。 */
const previewEntries = computed<PreviewEntry[]>(() => {
  if (module.value === "guestbook") return [];
  const entries: PreviewEntry[] = [];
  for (const item of items.value) {
    if (!item.coverUrl) continue;
    entries.push({
      id: item.id,
      item,
      title: item.title,
      meta: formatTime(item.createdAt),
      summary: item.summary,
    });
  }
  return entries;
});
const lightboxEntry = computed(() => (lightboxIndex.value >= 0 ? previewEntries.value[lightboxIndex.value] : undefined));

function releaseImages() {
  mediaSequence += 1;
  Object.keys(originalSources).forEach(key => delete originalSources[Number(key)]);
  Object.keys(originalErrors).forEach(key => delete originalErrors[Number(key)]);
  Object.values(imageSources).forEach((url) => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
  Object.keys(imageSources).forEach((key) => delete imageSources[Number(key)]);
}
async function loadCover(item: LibraryItem) {
  if (!item.coverUrl || imageSources[item.id]) return;
  try { imageSources[item.id] = await loadRemoteImageBlob(item.coverUrl); } catch { /* card keeps its media placeholder */ }
}
async function load() {
  const sequence = ++loadSequence;
  loading.value = true;
  error.value = "";
  try {
    const [result, availableYears] = await Promise.all([
      listQzoneLibrary(module.value, parentKey.value, query.value.trim() || undefined, selectedYear.value || undefined, pageSize.value, first.value),
      listQzoneLibraryYears(module.value, parentKey.value),
    ]);
    if (sequence !== loadSequence) return;
    releaseImages();
    page.value = result;
    items.value = result.items;
    years.value = availableYears;
    failedGuestbookAvatars.clear();
    void Promise.allSettled(result.items.map(loadCover));
  } catch (reason) {
    if (sequence === loadSequence) error.value = String(reason);
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}
async function sync() {
  if (syncing.value) return;
  syncing.value = true;
  const sourceModule = module.value;
  const sourceParent = parentKey.value;
  error.value = "";
  notice.value = "";
  try {
    const result = await syncQzoneLibrary(sourceModule, sourceParent);
    if (sourceModule !== module.value || sourceParent !== parentKey.value) return;
    notice.value = `已保存 ${result.saved} 条${result.complete ? "，本轮备份完成。" : "，备份尚未完成，可稍后继续。"}`;
    if (result.complete) toast.success(notice.value);
    else toast.info(notice.value);
    first.value = 0;
    await load();
  } catch (reason) {
    if (sourceModule === module.value && sourceParent === parentKey.value) {
      const syncFailure = String(reason);
      // load() 首行会清空 error，而且它自身失败时的文案（「读取失败」）不该盖过本轮备份的真实原因；
      // 用 finally 把备份失败原因写回，避免限流／凭证失效被显示成读取失败。
      try { await load(); } finally { error.value = syncFailure; }
    }
  }
  finally { syncing.value = false; }
}
function openItem(item: LibraryItem) {
  if (module.value === "albums") {
    void router.push({ name: "album-photos", params: { albumId: item.itemKey }, query: { title: item.title } });
  }
}
const mediaOpening = reactive(new Set<number>());
const originalSources = reactive<Record<number,string>>({});
const originalErrors = reactive<Record<number,string>>({});
const videoVisible = ref(false), videoSource = ref(""), videoTitle = ref(""), videoError = ref("");
const activeVideoItem = ref<LibraryItem>();
const videoChoicesVisible = ref(false), videoChoiceQuery = ref("");
const choicesLoading = ref(false);
const choiceOffset = ref(0), choicesTotal = ref(0);
const videoChoices = ref<LibraryItem[]>([]);
const linkingVideo = ref(false);
let choiceSequence = 0;
async function loadVideoChoices() {
  const sequence = ++choiceSequence;
  choicesLoading.value = true;
  try { const result = await listQzoneLibrary("videos",undefined,videoChoiceQuery.value.trim() || undefined,undefined,50,choiceOffset.value); if (sequence === choiceSequence) { videoChoices.value = result.items; choicesTotal.value = result.total; } }
  catch (reason) { toast.error(describeError(reason,"视频列表读取失败，请重试。")); }
  finally { if (sequence === choiceSequence) choicesLoading.value = false; }
}
async function chooseVideo() { videoChoicesVisible.value = true; videoChoiceQuery.value = ""; choiceOffset.value = 0; await loadVideoChoices(); }
async function confirmVideoChoice(video: LibraryItem) {
  const photo = activeVideoItem.value;
  if (!photo || linkingVideo.value) return;
  linkingVideo.value = true;
  try { await linkLibraryVideo(photo.id,video.id); videoChoicesVisible.value = false; await openMedia(photo); }
  catch (reason) { toast.error(describeError(reason,"视频没有关联成功，请重试。")); }
  finally { linkingVideo.value = false; }
}
function showVideoCover() { const item = activeVideoItem.value; videoVisible.value = false; if (item) openLightbox(item); }
let lastVideoRefresh = 0;
let mediaSequence = 0;
async function originalImage(item: LibraryItem) {
  if (originalSources[item.id] || mediaOpening.has(item.id)) return;
  mediaOpening.add(item.id); originalErrors[item.id] = "";
  const sequence = mediaSequence;
  try {
    const result = await loadLibraryMedia(item.id);
    if (sequence !== mediaSequence) return;
    originalSources[item.id] = convertFileSrc(result.path);
  } catch (reason) { if (sequence === mediaSequence) originalErrors[item.id] = describeError(reason,"原图暂时取不到，请重试。"); }
  finally { mediaOpening.delete(item.id); }
}
async function openMedia(item: LibraryItem) {
  if (!item.isVideo) { openLightbox(item); return; }
  if (mediaOpening.has(item.id)) return;
  const sequence = ++mediaSequence;
  activeVideoItem.value = item;
  mediaOpening.add(item.id);
  closeLightbox();
  videoVisible.value = true; videoSource.value = ""; videoTitle.value = item.title; videoError.value = "";
  try {
    let result;
    try { result = await loadLibraryMedia(item.id); }
    catch (reason) {
      // Refresh only expired/missing video URLs, never network failures or licence errors.
      if (!/HTTP 403|未找到.*播放地址/.test(String(reason)) || Date.now() - lastVideoRefresh < 60_000) throw reason;
      lastVideoRefresh = Date.now();
      videoError.value = "正在刷新视频播放地址…";
      const refreshed = await syncQzoneLibrary("videos");
      if (!refreshed.complete) throw new Error("视频列表未读取完整，请稍后重新备份视频。");
      if (sequence !== mediaSequence) return;
      result = await loadLibraryMedia(item.id);
    }
    if (sequence !== mediaSequence) return;
    closeLightbox();
    videoSource.value = convertFileSrc(result.path); videoError.value = "";
  } catch (reason) { if (sequence === mediaSequence) videoError.value = describeError(reason,"视频暂时无法播放，请重试；封面仍可查看。"); }
  finally { mediaOpening.delete(item.id); }
}
function retryOriginal() {
  const item = lightboxEntry.value?.item;
  if (!item) return;
  delete originalSources[item.id];
  if (item.isVideo) void reloadCover(item); else void originalImage(item);
}
function clearFilters() { query.value = ""; selectedYear.value = 0; first.value = 0; }
function changePage(event: PageState) { first.value = event.first; pageSize.value = event.rows; void load(); }

/* ------------------------------------------------------------------ 封面与灯箱 */

/** 包装已有 loadCover：只补一个「加载中」标记，不改变原来的取图方式。 */
async function ensureCover(item: LibraryItem) {
  if (!item.coverUrl || imageSources[item.id] || coverLoading.has(item.id)) return;
  coverLoading.add(item.id);
  try { await loadCover(item); } finally { coverLoading.delete(item.id); }
}

async function reloadCover(item: LibraryItem) {
  const existing = imageSources[item.id];
  if (existing?.startsWith("blob:")) URL.revokeObjectURL(existing);
  delete imageSources[item.id];
  await ensureCover(item);
}

function tileStatus(item: LibraryItem) {
  if (module.value === "albums") return "打开相册查看照片";
  if (module.value === "guestbook" && item.itemKey.startsWith("history:")) return "来自历史互动，留言可能已被删除";
  return page.value?.complete ? "已保存记录" : "备份未完成";
}

/** 相册卡片把「照片数」摆在最显眼的位置，其余模块沿用备份状态文案。 */
function tileFootnote(item: LibraryItem) {
  if (module.value === "albums" && item.mediaUrls.length) return `${item.mediaUrls.length} 个媒体地址`;
  return tileStatus(item);
}

/** 卡片主点击：相册进相册，视频开媒体，其余进灯箱看大图。 */
function activateItem(item: LibraryItem) {
  if (module.value === "albums") return openItem(item);
  if (item.isVideo) return void openMedia(item);
  openLightbox(item);
}

function openLightbox(item: LibraryItem) {
  const index = previewEntries.value.findIndex((entry) => entry.id === item.id);
  if (index < 0) return;
  lightboxIndex.value = index;
  if (!item.isVideo && ["photos","videos"].includes(item.module)) void originalImage(item);
}
function closeLightbox() { lightboxIndex.value = -1; }
function handleCoverError(item: LibraryItem) {
  const source = imageSources[item.id];
  if (source?.startsWith("blob:")) URL.revokeObjectURL(source);
  delete imageSources[item.id];
}
function stepLightbox(delta: number) {
  const count = previewEntries.value.length;
  if (count < 2) return;
  lightboxIndex.value = (lightboxIndex.value + delta + count) % count;
  const item = lightboxEntry.value?.item;
  if (item && !item.isVideo && item.module === "photos") void originalImage(item);
}

watch(() => authStore.user?.uin, () => { closeLightbox(); videoVisible.value = false; releaseImages(); void load(); });
onMounted(load);
watch(() => [route.name, route.params.albumId], () => { first.value = 0; selectedYear.value = 0; query.value = ""; void load(); });
watch(selectedYear, () => { first.value = 0; void load(); });
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { first.value = 0; void load(); }, 260);
});
// 列表被整体替换后，旧索引可能指向别的照片，直接关掉灯箱更安全。
watch(items, () => { lightboxIndex.value = -1; });

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  releaseImages();

});
</script>

<template>
  <div class="library">
    <!-- ------------------------------------------------- 模块说明 + 备份入口 -->
    <SectionCard>
      <div class="library__head">
        <div class="library__intro">
          <button
            v-if="module === 'photos'"
            class="library__back"
            type="button"
            aria-label="返回相册列表"
            @click="router.push('/albums')"
          >
            <ArrowLeft :size="16" :stroke-width="1.8" />
          </button>
          <span class="library__badge" aria-hidden="true">
            <component :is="moduleInfo.icon" :size="20" :stroke-width="1.8" />
          </span>
          <div class="library__copy">
            <p class="library__eyebrow">{{ moduleInfo.kicker }}</p>
            <h2 class="library__title" :class="{ 'qza-visually-hidden': module !== 'photos' }">{{ moduleInfo.title }}</h2>
            <p class="library__desc">{{ moduleInfo.description }}</p>
          </div>
        </div>

        <div class="library__action">
          <p class="library__sync" :class="`is-${syncState.tone}`">
            <component :is="syncState.icon" :size="15" :stroke-width="1.8" />
            <span>{{ syncState.text }}</span>
          </p>
          <p class="library__sync-hint">{{ syncState.detail }}</p>
          <p class="library__sync-hint">上次备份：{{ syncedTime }}</p>
          <button v-if="!authStore.loggedIn" class="btn btn--primary" type="button" @click="authStore.openLogin">登录 QQ 空间后备份</button>
          <button v-else class="btn btn--primary" type="button" :disabled="syncing" @click="sync">
            <LoaderCircle v-if="syncing" class="is-spinning" :size="16" :stroke-width="1.8" />
            <RefreshCw v-else :size="16" :stroke-width="1.8" />
            <span>{{ syncing ? "正在备份…" : moduleInfo.action }}</span>
          </button>
        </div>
      </div>

      <!-- ------------------------------------------------------ 检索与刷新 -->
      <div class="library__toolbar">
        <label class="library__search">
          <Search :size="15" :stroke-width="1.8" aria-hidden="true" />
          <span class="qza-visually-hidden">搜索</span>
          <InputText v-model="query" type="search" placeholder="搜索标题、正文、昵称或 QQ 号" aria-label="搜索当前列表" />
        </label>

        <Select
          v-model="selectedYear"
          class="library__select"
          :options="yearOptions"
          option-label="label"
          option-value="value"
          aria-label="按年份筛选"
        />

        <button class="btn btn--ghost" type="button" :disabled="loading" @click="load">
          <LoaderCircle v-if="loading" class="is-spinning" :size="15" :stroke-width="1.8" />
          <RefreshCw v-else :size="15" :stroke-width="1.8" />
          <span>刷新本地</span>
        </button>

        <span class="library__count">{{ page ? `共 ${page.total} 条` : loading ? "正在读取…" : "尚未读取" }}</span>
      </div>
    </SectionCard>

    <!-- ------------------------------------------------------------ 提示区 -->
    <p v-if="notice" class="banner banner--success">
      <CircleCheck :size="15" :stroke-width="1.8" />
      <span>{{ notice }}</span>
    </p>

    <div v-if="error" class="banner banner--danger" role="alert">
      <CircleAlert :size="15" :stroke-width="1.8" />
      <div class="banner__body">
        <p>{{ errorText }}</p>
        <details class="banner__more">
          <summary>查看详细原因</summary>
          <p>{{ diagnosticError(error) }}</p>
        </details>
      </div>
      <button class="btn btn--ghost" type="button" @click="load">重试</button>
    </div>

    <p v-else-if="page?.lastError" class="banner banner--warning">
      <CircleAlert :size="15" :stroke-width="1.8" />
      <span>上次备份未完成，已保存的内容会保留。点击备份可继续读取。</span>
    </p>

    <!-- ------------------------------------------------------------ 内容区 -->
    <section v-if="loading && !items.length && module === 'guestbook'" class="library__list" aria-busy="true">
      <SectionCard v-for="index in 4" :key="index" flush class="guest">
        <div class="guest__head">
          <SkeletonBlock circle width="32px" />
          <div class="guest__who">
            <SkeletonBlock width="120px" height="13px" />
            <SkeletonBlock width="180px" height="11px" />
          </div>
        </div>
        <SkeletonBlock :lines="2" />
      </SectionCard>
    </section>

    <section v-else-if="loading && !items.length" class="library__grid" :class="`is-${module}`" aria-busy="true">
      <SectionCard v-for="index in skeletonCount" :key="index" flush class="tile">
        <SkeletonBlock class="tile__skeleton" height="100%" />
        <div class="tile__body">
          <SkeletonBlock width="72%" height="13px" />
          <SkeletonBlock width="46%" height="11px" />
        </div>
      </SectionCard>
    </section>

    <section v-else-if="items.length && module === 'guestbook'" class="library__list">
      <SectionCard v-for="item in items" :key="item.id" flush class="guest">
        <div class="guest__head">
          <span class="guest__avatar" aria-hidden="true">
            <img
              v-if="item.authorUin && !failedGuestbookAvatars.has(item.id)"
              :src="guestbookAvatarUrl(item.authorUin)"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="failedGuestbookAvatars.add(item.id)"
            />
            <span v-else>{{ guestbookInitial(item) }}</span>
          </span>
          <span class="guest__who">
            <strong :title="item.authorUin ? `QQ ${item.authorUin}` : undefined">{{ item.authorName || item.title || "QQ 用户" }}</strong>
            <small>{{ item.authorUin ? `QQ ${item.authorUin} · ` : "" }}{{ formatTime(item.createdAt) }}</small>
          </span>
          <span v-if="item.itemKey.startsWith('history:')" class="guest__tag">历史互动残留</span>
        </div>

        <p class="guest__message selectable" :class="{ 'is-collapsed': item.summary.length > 260 && !expandedEntries.has(item.id) }">{{ item.summary || "（留言正文未保留）" }}</p>
        <button v-if="item.summary.length > 260" class="link guest__expand" type="button" :aria-expanded="expandedEntries.has(item.id)" @click="expandedEntries.has(item.id) ? expandedEntries.delete(item.id) : expandedEntries.add(item.id)">{{ expandedEntries.has(item.id) ? '收起留言' : '展开完整留言' }}</button>

        <div class="guest__foot">
          <span :title="tileStatus(item)">{{ tileFootnote(item) }}</span>
          <button v-if="item.mediaUrls.length" class="link" type="button" @click="openMedia(item)">
            <ExternalLink :size="14" :stroke-width="1.8" />
            <span>打开媒体</span>
          </button>
        </div>
      </SectionCard>
    </section>

    <section v-else-if="items.length" class="library__grid" :class="`is-${module}`">
      <SectionCard v-for="item in items" :key="item.id" flush class="tile">
        <div class="tile__visual">
          <img
            v-if="imageSources[item.id]"
            :src="imageSources[item.id]"
            :alt="`${item.title} 封面`"
            width="560"
            height="360"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            @error="handleCoverError(item)"
          />
          <div v-else class="tile__blank">
            <component :is="moduleInfo.icon" :size="22" :stroke-width="1.8" />
            <span v-if="coverLoading.has(item.id)" class="tile__blank-text">正在加载封面…</span>
            <button v-else-if="item.coverUrl" class="link tile__retry" type="button" @click.stop="reloadCover(item)">
              <RefreshCw :size="14" :stroke-width="1.8" />
              <span>封面未加载，重试</span>
            </button>
            <span v-else class="tile__blank-text">没有封面图</span>
          </div>

          <span v-if="item.mediaUrls.length" class="tile__badge" :title="`${item.mediaUrls.length} 个媒体地址`">
            {{ item.mediaUrls.length }}
          </span>
          <span v-if="module === 'videos'" class="tile__play" aria-hidden="true">
            <Film :size="16" :stroke-width="1.8" />
          </span>

          <button
            class="tile__hit"
            type="button"
            :disabled="module !== 'albums' && module !== 'videos' && !item.coverUrl"
            :aria-label="module === 'albums' ? `打开相册：${item.title}` : item.isVideo ? `播放视频：${item.title}` : `预览：${item.title}`"
            @click="activateItem(item)"
          />
        </div>

        <div class="tile__body">
          <h3 class="tile__title" :title="item.title">{{ item.title }}</h3>

          <p v-if="item.authorName || item.authorUin" class="tile__meta">
            <span :title="item.authorUin ? `QQ ${item.authorUin}` : undefined">{{ item.authorName || item.authorUin }}</span>
          </p>

          <p v-if="module === 'photos' || module === 'videos'" class="tile__meta">
            <span>{{ formatTime(item.createdAt) }}</span>
          </p>

          <p v-if="item.summary" class="tile__summary selectable" :class="{ 'is-expanded': expandedEntries.has(item.id) }">{{ item.summary }}</p>
          <button v-if="item.summary.length > 120" class="link" type="button" :aria-expanded="expandedEntries.has(item.id)" @click="expandedEntries.has(item.id) ? expandedEntries.delete(item.id) : expandedEntries.add(item.id)">{{ expandedEntries.has(item.id) ? '收起' : '展开全文' }}</button>

          <div class="tile__foot">
            <span :title="tileStatus(item)">{{ tileFootnote(item) }}</span>
            <button v-if="module === 'albums'" class="link" type="button" @click="openItem(item)">
              <span>进入相册</span>
              <ChevronRight :size="14" :stroke-width="1.8" />
            </button>
            <button v-else-if="item.mediaUrls.length" class="link" type="button" @click="openMedia(item)">
              <ExternalLink :size="14" :stroke-width="1.8" />
              <span>{{ item.isVideo ? '播放视频' : '查看原图' }}</span>
            </button>
            <button v-else-if="item.coverUrl" class="link" type="button" @click="openLightbox(item)">
              <span>查看大图</span>
              <ChevronRight :size="14" :stroke-width="1.8" />
            </button>
          </div>
        </div>
      </SectionCard>
    </section>

    <SectionCard v-else>
      <EmptyState
        :icon="error ? CircleAlert : moduleInfo.icon"
        :tone="error ? 'danger' : 'neutral'"
        :title="emptyTitle"
        :description="emptyHint"
      >
        <button v-if="error" class="btn btn--ghost" type="button" @click="load">
          <RefreshCw :size="15" :stroke-width="1.8" />
          <span>重试</span>
        </button>
        <button v-else-if="hasFilter" class="btn btn--ghost" type="button" @click="clearFilters">清除筛选</button>
        <button v-else-if="!authStore.loggedIn" class="btn btn--primary" type="button" @click="authStore.openLogin">登录 QQ 空间</button>
        <button v-else class="btn btn--primary" type="button" :disabled="syncing" @click="sync">{{ syncing ? '正在备份…' : moduleInfo.action }}</button>
      </EmptyState>
    </SectionCard>

    <Paginator
      v-if="(page?.total || 0) > pageSize"
      class="library__pager"
      :first="first"
      :rows="pageSize"
      :total-records="page?.total || 0"
      :rows-per-page-options="[12, 24, 48, 96]"
      :page-link-size="3"
      @page="changePage"
    />
  </div>

  <!-- --------------------------------------------------------------- 灯箱 -->
  <ImageViewer v-if="lightboxEntry" :src="originalSources[lightboxEntry.id] || (!mediaOpening.has(lightboxEntry.id) ? imageSources[lightboxEntry.id] : undefined)" :name="mediaFileName(lightboxEntry.item.createdAt, lightboxEntry.title)" :title="lightboxEntry.title" :index="lightboxIndex" :total="previewEntries.length" :loading="mediaOpening.has(lightboxEntry.id)" :error="originalErrors[lightboxEntry.id]" @close="closeLightbox" @step="stepLightbox" @retry="retryOriginal" @saved="toast.success('图片已保存')" @error="toast.error($event)">
    <p v-if="originalErrors[lightboxEntry.id]" role="status">{{ originalErrors[lightboxEntry.id] }} · 当前显示预览图</p>
    <button v-if="lightboxEntry.item.isVideo" type="button" class="btn btn--ghost" @click="openMedia(lightboxEntry.item)">播放视频</button>
  </ImageViewer>
  <Dialog v-model:visible="videoVisible" modal :draggable="false" :header="videoTitle || '播放视频'" class="library-video-dialog">
    <video v-if="videoSource" :src="videoSource" controls autoplay playsinline preload="metadata" @error="videoError = '当前设备无法播放这个视频格式，已保存的文件会保留。'" />
    <p v-else-if="!videoError" role="status">正在读取视频…</p>
    <button v-if="videoSource && activeVideoItem?.module === 'photos'" type="button" class="btn btn--ghost" @click="videoVisible = false; chooseVideo()">更换对应视频</button>
    <p v-if="videoError" role="status">{{ videoError }}</p>
    <div v-if="videoError && !mediaOpening.has(activeVideoItem?.id || 0)" class="video-recovery"><button type="button" class="btn btn--ghost" @click="showVideoCover">查看封面</button><button v-if="activeVideoItem?.module === 'photos'" type="button" class="btn btn--ghost" @click="videoVisible = false; chooseVideo()">选择对应视频</button><button v-if="activeVideoItem" type="button" class="btn btn--ghost" @click="openMedia(activeVideoItem)">重试播放</button></div>
  </Dialog>
  <Dialog v-model:visible="videoChoicesVisible" modal :draggable="false" header="选择对应视频" class="library-video-dialog">
    <p>这条相册记录没有保留明确的视频标识。请从本账号已保存的视频中选择对应内容。</p>
    <InputText v-model="videoChoiceQuery" placeholder="输入视频标题搜索" aria-label="搜索对应视频" @input="choiceOffset = 0; loadVideoChoices()" />
    <div class="video-choices"><button v-for="video in videoChoices" :key="video.id" type="button" class="btn btn--ghost" :disabled="linkingVideo" @click="confirmVideoChoice(video)">{{ video.title }} · {{ formatTime(video.createdAt) }}</button></div>
    <Paginator v-if="choicesTotal > 50" :first="choiceOffset" :rows="50" :total-records="choicesTotal" template="PrevPageLink CurrentPageReport NextPageLink" @page="choiceOffset = $event.first; loadVideoChoices()" />
    <p v-if="choicesLoading" role="status">正在读取视频列表…</p>
    <p v-else-if="!videoChoices.length">没有找到视频，可先到「视频」页面备份列表，或换个关键词。</p>
  </Dialog>
</template>

<style scoped>
.video-recovery {display:flex; flex-wrap:wrap; gap:var(--space-2);}
.video-choices {display:grid; gap:var(--space-2); margin-top:var(--space-3);}
.library-video-dialog video {display:block; width:100%; max-height:70dvh;}
:global(.library-video-dialog) {width:min(900px, calc(100vw - var(--space-6)));}

.library {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* --------------------------------------------------------------- 头部与工具 */

.library__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  flex-wrap: wrap;
}

.library__intro {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
  flex: 1 1 320px;
}

.library__back {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  transition: border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.library__back:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.library__copy {
  min-width: 0;
}

.library__desc {
  margin-top: var(--space-1);
  max-width: 62ch;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.library__action {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
  flex-shrink: 0;
  text-align: right;
}

.library__sync {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.library__sync.is-success {
  color: var(--color-success);
}

.library__sync.is-warning {
  color: var(--color-warning);
}

.library__sync.is-idle {
  color: var(--color-text-tertiary);
}

.library__sync-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.library__action .btn {
  margin-top: var(--space-2);
}

.library__toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: var(--line-width) solid var(--color-border);
}

.library__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 220px;
  min-width: 0;
  max-width: 420px;
  height: 36px;
  padding: 0 var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
  transition: border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.library__search:focus-within {
  border-color: var(--color-accent);
  background: var(--color-surface);
  box-shadow: var(--shadow-focus);
}

.library__search :deep(.p-inputtext) {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  font-size: var(--text-sm);
}

.library__search :deep(.p-inputtext:focus) {
  border: 0;
  box-shadow: none;
}

.library__select {
  min-width: 150px;
  max-width: 220px;
}

.library__count {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ---------------------------------------------------------------- 通用控件 */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-4);
  border: var(--line-width) solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.btn--primary {
  background: var(--color-accent);
  color: var(--color-text-inverse);
}

.btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.btn--primary:active:not(:disabled) {
  background: var(--color-accent-active);
}

.btn--ghost {
  border-color: var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.btn--ghost:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.link:hover {
  color: var(--color-accent-hover);
  text-decoration: underline;
}

.is-spinning {
  animation: library-spin 1s linear infinite;
}

@keyframes library-spin {
  to { transform: rotate(360deg); }
}

/* ---------------------------------------------------------------- 提示条 */

.banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.banner--success {
  border-color: var(--color-success);
  background: var(--color-success-soft);
  color: var(--color-success);
}

.banner--warning {
  border-color: var(--color-warning);
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.banner--danger {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.banner__body {
  flex: 1;
  min-width: 0;
}

.banner__more summary {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  cursor: pointer;
  color: var(--color-text-tertiary);
}

.banner__more p {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  word-break: break-word;
}

/* ------------------------------------------------------------ 网格与卡片 */

.library__grid.is-albums {
  --tile-ratio: 4 / 3;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.library__grid.is-photos {
  --tile-ratio: 1 / 1;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
}

.library__grid.is-videos {
  --tile-ratio: 16 / 9;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}

.library__grid.is-favorites {
  --tile-ratio: 4 / 3;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}

.tile__visual img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile__blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  height: 100%;
  padding: var(--space-3);
  text-align: center;
  color: var(--color-text-tertiary);
}

.tile__blank-text {
  font-size: var(--text-xs);
}

.tile__badge {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-2);
  z-index: 2;
  min-width: 22px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  line-height: 18px;
  text-align: center;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.tile__play {
  position: absolute;
  left: var(--space-2);
  bottom: var(--space-2);
  z-index: 2;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
}

.tile__hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  border: 0;
  background: transparent;
}

.tile__hit:hover {
  box-shadow: inset 0 0 0 1px var(--color-border-strong);
}

.tile__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4) var(--space-4);
}

.tile__title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.tile__meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile__summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.tile__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: var(--line-width) solid var(--color-border);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.tile__foot > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile__skeleton {
  aspect-ratio: var(--tile-ratio, 4 / 3);
  gap: 0;
}

/* ---------------------------------------------------------------- 留言列表 */

.library__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.guest__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.guest__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--space-8);
  height: var(--space-8);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.guest__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.guest__who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.guest__who strong {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guest__who small {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.guest__tag {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-2);
  border: var(--line-width) solid var(--color-warm-border);
  border-radius: var(--radius-full);
  background: var(--color-warm-soft);
  color: var(--color-warm);
  font-size: var(--text-2xs);
}

.guest__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: var(--line-width) solid var(--color-border);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.guest__foot > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------------------------------------------ 分页 */

.library__pager {
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  border: 0;
  background: transparent;
}

.library__pager :deep(.p-paginator-page),
.library__pager :deep(.p-paginator-first),
.library__pager :deep(.p-paginator-prev),
.library__pager :deep(.p-paginator-next),
.library__pager :deep(.p-paginator-last) {
  min-width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
}

.library__pager :deep(.p-paginator-page.p-paginator-page-selected) {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.library__pager :deep(.p-paginator-current) {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.library__pager :deep(.p-select) {
  min-width: 0;
}

/* ------------------------------------------------------------------ 灯箱 */

/* ------------------------------------------------------------------ 响应式 */

@media (max-width: 1080px) {
  .library {
    gap: var(--space-4);
  }

  .library__head {
    gap: var(--space-4);
  }
}

@media (max-width: 860px) {
  .library__head {
    flex-direction: column;
  }

  .library__action {
    align-items: stretch;
    text-align: left;
  }

  .library__sync {
    justify-content: flex-start;
  }

  .library__toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .library__search,
  .library__select,
  .library__toolbar .btn {
    width: 100%;
    max-width: none;
    flex: 0 0 auto;
  }

  .library__count {
    margin-left: 0;
  }
}

.library__title {
  margin-top: var(--space-1);
  font-weight: var(--weight-semibold); font-size:var(--text-2xl); letter-spacing:-.025em; }
.library__eyebrow {
  font-weight: var(--weight-medium);
  text-transform: uppercase; color:var(--color-text-secondary); letter-spacing:0; font-size:var(--text-xs); margin-bottom:var(--space-2); }
.library__badge {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--space-10);
  height: var(--space-10);
  color: var(--color-accent); border-radius:var(--radius-lg); background:var(--color-accent-soft); }
.library__grid {
  display: grid;
  gap: var(--density-gap, var(--space-4));
  align-items: start; grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--layout-gallery-cell)),1fr)); }
.tile__visual {
  position: relative;
  aspect-ratio: var(--tile-ratio, 4 / 3);
  overflow: hidden; background:var(--color-photo-mat); }
.tile__retry {
  font-size: var(--text-xs); position:relative; z-index:1; }
.tile { transition:border-color var(--duration-fast) var(--ease-out),box-shadow var(--duration-fast) var(--ease-out); }
.tile:hover { border-color:var(--color-accent-border); box-shadow:var(--shadow-sm); }
.guest {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--density-card-padding, var(--space-5)); position:relative; margin-left:var(--space-3); border-left:var(--focus-width) solid var(--color-warm-border); }
.guest__message {
  font-size: var(--text-base);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word; max-width:72ch; line-height:var(--leading-relaxed); }
@media (max-width:860px) { .library__toolbar { align-items:stretch; } .library__action { width:100%; align-items:flex-start; } .library__head { gap:var(--space-4); } .library__intro { flex-basis:100%; } .btn,.library__back { min-height:var(--touch-target); } }

.guest__message.is-collapsed { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.tile__summary.is-expanded { display: block; -webkit-line-clamp: unset; }
.guest__expand { padding-block: var(--space-2); }

/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .library { gap:var(--layout-page-gap); }
.library__head { align-items:center; gap:var(--space-5); }
.library__title { font-size:var(--text-lg); font-family:var(--font-display); letter-spacing:normal; }
.library__eyebrow { display:none; }
.library__badge { width:var(--control-height); height:var(--control-height); border-radius:var(--radius-md); }
.library__desc { margin-top:var(--space-1); max-width:64ch; }
.library__action { gap:var(--space-2); }
.library__toolbar { gap:var(--space-3); }
.tile { box-shadow:none; border-radius:var(--radius-md); }
.tile:hover { box-shadow:var(--shadow-xs); }
.guest { background:var(--color-surface); }
@media(max-width:600px) { .library__head { gap:var(--space-4); } .library__action { align-items:stretch; } .library__action .btn { width:100%; } }
</style>
