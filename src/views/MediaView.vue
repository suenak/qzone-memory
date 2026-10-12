<script setup lang="ts">
import { describeError } from "../utils/uiError";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import Dialog from "primevue/dialog";
import Select from "primevue/select";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Film,
  Heart,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircle,
  Play,
  RefreshCw,
  User,
  X,
} from "lucide-vue-next";
import QzoneText from "../components/QzoneText.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import { usePreviewFocus } from "../composables/usePreviewFocus";
import { loadRemoteImageBlob } from "../utils/archiveImage";
import { getArchivedFeed, listArchivedMedia, loadArchivedImage, loadArchivedVideo, type ArchiveItem, type ArchiveMediaItem } from "../utils/qzone";

const PAGE_SIZE = 60;
const media = ref<ArchiveMediaItem[]>([]);
const years = ref<number[]>([]);
const selectedYear = ref(0);
const total = ref(0);
const loading = ref(false);
const error = ref("");
const detailVisible = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const detailTarget = ref<ArchiveMediaItem>();
let loadSequence = 0;
let detailSequence = 0;
const detail = ref<ArchiveItem>();
const imageSources = reactive<Record<string, string>>({});
const imageLoading = reactive<Record<string, boolean>>({});
const imageErrors = reactive<Record<string, string>>({});
const imageFallbackAttempted = reactive<Record<string, boolean>>({});
const videoSource = ref("");
const videoLoading = ref(false);
const videoError = ref("");
let imageObserver: IntersectionObserver | undefined;
let loadObserver: IntersectionObserver | undefined;

/** 后端返回空页时置位，表示确实没有下一页。不能用改写 total 的方式表达「到底了」，那会伪造总数。 */
const exhausted = ref(false);
const hasMore = computed(() => !exhausted.value && media.value.length < total.value);
const yearOptions = computed(() => [{ label: "全部年份", value: 0 }, ...years.value.map((year) => ({ label: `${year} 年`, value: year }))]);
const formatTime = (seconds: number) => seconds ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000)) : "时间未知";
// 模板里以方法调用求值：带时间戳会让详情头与评论头像在每次重渲染时重新发起请求，固定地址交给 HTTP 缓存即可。
const avatarUrl = (uin?: string) => uin ? `https://qlogo2.store.qq.com/qzone/${uin}/${uin}/50` : "";

/* ------------------------------------------------------------------ 纯 UI 状态
 * 年份分组、灯箱与占位文案都只影响渲染，取数流程与上面完全一致。 */

interface LightboxEntry {
  key: string;
  url: string;
  dynamicId?: number;
  pictureIndex?: number;
  caption: string;
  meta: string;
  item?: ArchiveMediaItem;
}

const lightboxList = ref<LightboxEntry[]>([]);
const lightboxIndex = ref(-1);
usePreviewFocus(computed(() => lightboxIndex.value >= 0), closeLightbox);

/** 按年份切段，增量加载时同一年的两页会自动接在一起。 */
const groupedMedia = computed(() => {
  const groups: { year: number; items: ArchiveMediaItem[] }[] = [];
  for (const item of media.value) {
    const year = item.publishedAt ? new Date(item.publishedAt * 1000).getFullYear() : 0;
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.items.push(item);
    else groups.push({ year, items: [item] });
  }
  return groups;
});

const yearLabel = (year: number) => (year > 0 ? `${year} 年` : "时间未知");
const shotUrl = (item: ArchiveMediaItem) => (item.mediaType === "photo" ? item.url : item.coverUrl || "");
const shotAlt = (item: ArchiveMediaItem) => `${item.authorName || "QQ 用户"}的备份${item.mediaType === "video" ? "视频封面" : "照片"}`;
const shotLabel = (item: ArchiveMediaItem) => `查看 ${item.authorName || "QQ 用户"} 于 ${formatTime(item.publishedAt)} 发布的${item.mediaType === "video" ? "视频" : "照片"}`;

const lightboxEntries = computed<LightboxEntry[]>(() => {
  const entries: LightboxEntry[] = [];
  for (const item of media.value) {
    const url = shotUrl(item);
    if (!url) continue;
    entries.push({
      key: item.key,
      url,
      dynamicId: item.mediaType === "photo" ? item.dynamicId : undefined,
      pictureIndex: item.mediaType === "photo" ? item.pictureIndex : undefined,
      caption: item.content || (item.mediaType === "video" ? "视频封面" : "照片"),
      meta: `${item.authorName || "QQ 用户"} · ${formatTime(item.publishedAt)}`,
      item,
    });
  }
  return entries;
});
const lightboxCurrent = computed(() => (lightboxIndex.value >= 0 ? lightboxList.value[lightboxIndex.value] : undefined));

const emptyTitle = computed(() => {
  if (error.value) return "媒体读取失败";
  if (selectedYear.value) return `${selectedYear.value} 年没有备份照片或视频`;
  return "还没有备份任何照片或视频";
});
const emptyDescription = computed(() => {
  if (error.value) return "请重试，已保存的内容会保留。";
  if (selectedYear.value) return "换一个年份，或把筛选切回「全部年份」看看全部媒体。";
  return "到「恢复任务」保存说说后，可在这里查看其中的照片和视频。";
});

async function load(reset = false) {
  if ((!reset && loading.value) || (!reset && !hasMore.value)) return;
  const sequence = reset ? ++loadSequence : loadSequence;
  loading.value = true;
  error.value = "";
  // 切换年份时先清空列表，否则加载期间还会继续渲染上一个年份的媒体。
  if (reset) { media.value = []; exhausted.value = false; }
  try {
    const page = await listArchivedMedia(PAGE_SIZE, reset ? 0 : media.value.length, selectedYear.value || undefined);
    if (sequence !== loadSequence) return;
    years.value = page.years;
    total.value = page.total;
    media.value = reset ? page.items : [...media.value, ...page.items];
    // 空页只说明「没有下一页」：把 total 改写成当前长度会伪造总数，这里用独立标志收尾。
    if (!page.items.length) exhausted.value = true;
    await nextTick();
    observeImages();
  } catch (reason) { if (sequence === loadSequence) error.value = `读取媒体失败：${String(reason)}`; }
  finally { if (sequence === loadSequence) loading.value = false; }
}

function observeImages() {
  imageObserver?.disconnect();
  imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target as HTMLElement;
      const url = element.dataset.mediaImage;
      const dynamicId = Number(element.dataset.dynamicId);
      const pictureIndex = Number(element.dataset.pictureIndex);
      if (url) void loadImage(url, Number.isFinite(dynamicId) ? dynamicId : undefined, Number.isFinite(pictureIndex) ? pictureIndex : undefined);
      imageObserver?.unobserve(element);
    }
  }, { rootMargin: "360px 0px" });
  document.querySelectorAll<HTMLElement>(".media-page [data-media-image]").forEach((element) => imageObserver?.observe(element));
}

async function loadImage(url: string, dynamicId?: number, pictureIndex?: number) {
  if (!url || imageSources[url] || imageLoading[url]) return;
  imageLoading[url] = true;
  delete imageErrors[url];
  delete imageFallbackAttempted[url];
  try {
    if (dynamicId !== undefined && pictureIndex !== undefined) {
      try {
        imageSources[url] = convertFileSrc(await loadArchivedImage(dynamicId, pictureIndex));
        return;
      } catch (reason) {
        console.warn("本地媒体图片加载失败，改用原始地址", reason);
      }
    }
    await loadRemoteImage(url);
  } catch (reason) { imageErrors[url] = String(reason); console.error("媒体图片加载失败", reason); }
  finally { imageLoading[url] = false; }
}
async function loadRemoteImage(url: string) {
  imageSources[url] = await loadRemoteImageBlob(url);
}
async function handleImageError(url: string) {
  if (!url || imageLoading[url]) return;
  const source = imageSources[url];
  if (source?.startsWith("blob:")) URL.revokeObjectURL(source);
  delete imageSources[url];
  if (imageFallbackAttempted[url]) {
    imageErrors[url] = "图片文件无法显示，可点击重试";
    return;
  }
  imageFallbackAttempted[url] = true;
  imageLoading[url] = true;
  try { await loadRemoteImage(url); }
  catch (reason) { imageErrors[url] = String(reason); }
  finally { imageLoading[url] = false; }
}

async function openOriginal(item: ArchiveMediaItem) {
  const sequence = ++detailSequence;
  detailTarget.value = item;
  detailError.value = "";
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = undefined;
  releaseVideo();
  try {
    const result = await getArchivedFeed(item.dynamicId);
    if (sequence !== detailSequence) return;
    detail.value = result;
    await Promise.all(detail.value.pictureUrls.map((url, index) => loadImage(url, detail.value?.id, index)));
    if (detail.value.videoCoverUrl) await loadImage(detail.value.videoCoverUrl);
  } catch (reason) { if (sequence === detailSequence) detailError.value = describeError(reason, "说说详情读取失败，请重试。"); }
  finally { if (sequence === detailSequence) detailLoading.value = false; }
}

async function playVideo() {
  if (!detail.value?.videoUrl || videoLoading.value) return;
  videoLoading.value = true;
  videoError.value = "";
  try { videoSource.value = convertFileSrc(await loadArchivedVideo(detail.value.id)); }
  catch (reason) { videoError.value = `视频加载失败：${String(reason)}`; }
  finally { videoLoading.value = false; }
}

function releaseVideo() {
  if (videoSource.value.startsWith("blob:")) URL.revokeObjectURL(videoSource.value);
  videoSource.value = "";
  videoError.value = "";
}

/* ------------------------------------------------------------------ 灯箱交互 */

function ensureLightboxImage(entry: LightboxEntry | undefined) {
  if (!entry || !entry.url) return;
  if (imageSources[entry.url] || imageLoading[entry.url]) return;
  void loadImage(entry.url, entry.dynamicId, entry.pictureIndex);
}

/** 网格里的照片直接进灯箱，视频仍然走原始动态（里面有播放入口）。 */
function handleTileClick(item: ArchiveMediaItem) {
  if (item.mediaType === "video") { void openOriginal(item); return; }
  const index = lightboxEntries.value.findIndex((entry) => entry.key === item.key);
  if (index < 0) return;
  lightboxList.value = lightboxEntries.value;
  lightboxIndex.value = index;
  ensureLightboxImage(lightboxEntries.value[index]);
  ensureLightboxImage(lightboxEntries.value[index + 1]);
  ensureLightboxImage(lightboxEntries.value[index - 1]);
}

function openDetailPicture(index: number) {
  const current = detail.value;
  if (!current) return;
  const list: LightboxEntry[] = current.pictureUrls.map((url, position) => ({
    key: `detail:${position}`,
    url,
    dynamicId: current.id,
    pictureIndex: position,
    caption: current.content || "照片",
    meta: `${current.authorName || "QQ 用户"} · ${formatTime(current.publishedAt)}`,
  }));
  lightboxList.value = list;
  lightboxIndex.value = Math.min(index, list.length - 1);
  ensureLightboxImage(list[lightboxIndex.value]);
  ensureLightboxImage(list[lightboxIndex.value + 1]);
  ensureLightboxImage(list[lightboxIndex.value - 1]);
}

function closeLightbox() {
  lightboxIndex.value = -1;
  lightboxList.value = [];
}

/** 灯箱里的「查看说说」：先收起预览，再打开详情，避免两层浮层叠在一起。 */
function openLightboxOriginal() {
  const current = lightboxCurrent.value;
  if (!current?.item) return;
  closeLightbox();
  void openOriginal(current.item);
}

function stepLightbox(delta: number) {
  const list = lightboxList.value;
  if (list.length < 2) return;
  const next = (lightboxIndex.value + delta + list.length) % list.length;
  lightboxIndex.value = next;
  ensureLightboxImage(list[next]);
  ensureLightboxImage(list[next + 1]);
  ensureLightboxImage(list[next - 1]);
}

function retryLightboxImage() {
  const current = lightboxCurrent.value;
  if (!current) return;
  const source = imageSources[current.url];
  if (source?.startsWith("blob:")) URL.revokeObjectURL(source);
  delete imageSources[current.url];
  delete imageErrors[current.url];
  delete imageFallbackAttempted[current.url];
  void loadImage(current.url, current.dynamicId, current.pictureIndex);
}

function handleLightboxKey(event: KeyboardEvent) {
  if (lightboxIndex.value < 0) return;
  if (event.key === "Escape") { event.preventDefault(); closeLightbox(); }
  else if (event.key === "ArrowLeft") { event.preventDefault(); stepLightbox(-1); }
  else if (event.key === "ArrowRight") { event.preventDefault(); stepLightbox(1); }
}

watch(selectedYear, () => void load(true));
watch(detailVisible, (visible) => { if (!visible) { detailSequence += 1; releaseVideo(); } });
// 增量加载不会打断正在看的照片，只有索引真的失效时才收起灯箱。
watch(media, () => { if (lightboxIndex.value >= lightboxList.value.length) closeLightbox(); });
onMounted(() => {
  void load(true);
  loadObserver = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void load(); }, { rootMargin: "500px 0px" });
  const sentinel = document.querySelector(".media-load-sentinel");
  if (sentinel) loadObserver.observe(sentinel);
});
onMounted(() => window.addEventListener("keydown", handleLightboxKey));
onBeforeUnmount(() => {
  imageObserver?.disconnect(); loadObserver?.disconnect(); releaseVideo();
  Object.values(imageSources).forEach((url) => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
  window.removeEventListener("keydown", handleLightboxKey);
});
</script>

<template>
  <div class="media-page">
    <!-- ------------------------------------------------------------ 页面说明 -->
    <SectionCard>
      <div class="media-head">
        <div class="media-head__intro">
          <span class="media-head__badge" aria-hidden="true">
            <Camera :size="20" :stroke-width="1.8" />
          </span>
          <div>
            <p class="media-head__eyebrow">说说中的照片与视频</p><h2 class="media-head__title qza-visually-hidden">说说照片与视频</h2>
            <p class="media-head__desc">集中浏览说说备份中的照片与视频；QQ 相册内容请在「相册」中查看。</p>
          </div>
        </div>

        <div class="media-head__filter">
          <span class="media-head__total">{{ loading && !media.length ? "正在读取…" : error && !media.length ? "尚未读取" : `共 ${total} 项` }}</span>
          <label class="media-head__year" for="media-year">发布年份</label>
          <Select
            id="media-year"
            v-model="selectedYear"
            class="media-head__select"
            :options="yearOptions"
            option-label="label"
            option-value="value"
          />
        </div>
      </div>
    </SectionCard>

    <p v-if="error" class="banner" role="alert">
      <CircleAlert :size="15" :stroke-width="1.8" />
      <span>{{ describeError(error, "媒体读取没有完成，请重试。") }}</span>
      <button class="btn btn--ghost" type="button" :disabled="loading" @click="load(!media.length)">重试</button>
    </p>

    <!-- -------------------------------------------------------------- 骨架屏 -->
    <div v-if="loading && !media.length" class="shot-grid" aria-busy="true">
      <SectionCard v-for="index in 12" :key="index" flush class="shot shot--skeleton">
        <SkeletonBlock class="shot__skeleton" height="100%" />
        <div class="shot__meta">
          <SkeletonBlock width="62%" height="12px" />
          <SkeletonBlock width="40%" height="11px" />
        </div>
      </SectionCard>
    </div>

    <!-- ------------------------------------------------------------ 时光轴 -->
    <div v-else-if="media.length" class="timeline" aria-label="备份媒体">
      <section v-for="group in groupedMedia" :key="group.year" class="timeline__group">
        <header class="timeline__marker">
          <h3 class="timeline__year">{{ yearLabel(group.year) }}</h3>
          <span class="timeline__rule" aria-hidden="true" />
          <span class="timeline__count">{{ group.items.length }} 项</span>
        </header>

        <div class="shot-grid">
          <SectionCard v-for="item in group.items" :key="item.key" flush class="shot">
            <div
              class="shot__visual"
              :data-media-image="item.mediaType === 'photo' ? item.url : item.coverUrl"
              :data-dynamic-id="item.mediaType === 'photo' ? item.dynamicId : undefined"
              :data-picture-index="item.mediaType === 'photo' ? item.pictureIndex : undefined"
            >
              <img
                v-if="imageSources[shotUrl(item)]"
                :src="imageSources[shotUrl(item)]"
                :alt="shotAlt(item)"
                width="640"
                height="480"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                @error="handleImageError(shotUrl(item))"
              />
              <span v-else class="shot__placeholder">
                <component :is="item.mediaType === 'video' ? Film : ImageIcon" :size="20" :stroke-width="1.8" />
                <button
                  v-if="item.mediaType === 'photo' && imageErrors[item.url]"
                  class="link shot__retry"
                  type="button"
                  @click.stop="loadImage(item.url, item.dynamicId, item.pictureIndex)"
                >
                  <RefreshCw :size="13" :stroke-width="1.8" />
                  <span>加载失败，重试</span>
                </button>
                <span v-else class="shot__placeholder-text">
                  {{ imageLoading[shotUrl(item)] ? "正在加载图片…" : item.mediaType === "video" ? "视频" : "照片" }}
                </span>
              </span>

              <span v-if="item.mediaType === 'video'" class="shot__play" aria-hidden="true">
                <Play :size="15" :stroke-width="1.8" />
              </span>

              <button class="shot__hit" type="button" :aria-label="shotLabel(item)" @click="handleTileClick(item)" />
            </div>

            <div class="shot__meta">
              <strong>{{ item.authorName || "QQ 用户" }}</strong>
              <small>{{ formatTime(item.publishedAt) }}</small>
              <p v-if="item.content" class="shot__content selectable">{{ item.content }}</p>
              <button class="link shot__detail" type="button" @click="openOriginal(item)">
                <ExternalLink :size="14" :stroke-width="1.8" />
                <span>查看说说</span>
              </button>
            </div>
          </SectionCard>
        </div>
      </section>
    </div>

    <!-- -------------------------------------------------------------- 空状态 -->
    <SectionCard v-else>
      <EmptyState
        :icon="error ? CircleAlert : Camera"
        :tone="error ? 'danger' : 'neutral'"
        :title="emptyTitle"
        :description="emptyDescription"
      >
        <button v-if="error" class="btn" type="button" @click="load(true)">
          <RefreshCw :size="15" :stroke-width="1.8" />
          <span>重试</span>
        </button>
        <button v-else-if="selectedYear" class="btn" type="button" @click="selectedYear = 0">查看全部年份</button>
        <RouterLink v-else class="btn" to="/tasks">打开恢复任务</RouterLink>
      </EmptyState>
    </SectionCard>

    <div class="media-load-sentinel">
      <div v-if="loading && media.length" class="sentinel-busy">
        <LoaderCircle class="is-spinning" :size="16" :stroke-width="1.8" />
        <span>正在读取更多…</span>
      </div>
      <button v-else-if="hasMore" class="btn btn--ghost" type="button" @click="load()">加载更多</button>
      <span v-else-if="media.length" class="sentinel-end">已经到底了</span>
    </div>
  </div>

  <!-- ---------------------------------------------------------- 原始动态 -->
  <Dialog v-model:visible="detailVisible" modal :draggable="false" class="media-detail" header="说说详情">
    <div v-if="detailLoading" class="detail-loading">
      <SkeletonBlock circle width="36px" />
      <SkeletonBlock width="42%" height="13px" />
      <SkeletonBlock :lines="3" />
    </div>

    <EmptyState v-else-if="detailError" :icon="CircleAlert" tone="danger" title="说说详情读取失败" :description="detailError"><button class="btn" type="button" @click="detailTarget && openOriginal(detailTarget)">重试</button></EmptyState>
    <article v-else-if="detail" class="detail">
      <header class="detail__head">
        <span class="detail__avatar">
          <img
            v-if="detail.authorUin"
            :src="avatarUrl(detail.authorUin)"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />
          <User v-else :size="16" :stroke-width="1.8" />
        </span>
        <div class="detail__who">
          <strong>{{ detail.authorName || "QQ 用户" }}</strong>
          <small>
            <span v-if="detail.authorUin">QQ {{ detail.authorUin }} · </span>
            {{ formatTime(detail.publishedAt) }}
          </small>
        </div>
      </header>

      <p v-if="detail.content" class="detail__content selectable"><QzoneText :value="detail.content" /></p>

      <div v-if="detail.pictureUrls.length" class="detail__pictures">
        <template v-for="(url, index) in detail.pictureUrls" :key="url">
          <button
            v-if="imageSources[url]"
            class="detail__picture"
            type="button"
            :aria-label="`预览第 ${index + 1} 张图片`"
            @click="openDetailPicture(index)"
          >
            <img
              :src="imageSources[url]"
              :alt="`第 ${index + 1} 张图片`"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="handleImageError(url)"
            />
          </button>
          <button
            v-else
            class="detail__picture detail__picture--pending"
            type="button"
            :title="imageErrors[url]"
            @click="loadImage(url, detail.id, index)"
          >
            <ImageIcon :size="18" :stroke-width="1.8" />
            <span>{{ imageErrors[url] ? "加载失败，重试" : "图片加载中" }}</span>
          </button>
        </template>
      </div>

      <div v-if="videoSource" class="detail__video">
        <video :src="videoSource" controls autoplay playsinline />
      </div>
      <button v-else-if="detail.videoUrl" class="video-cover" type="button" @click="playVideo">
        <img
          v-if="detail.videoCoverUrl && imageSources[detail.videoCoverUrl]"
          :src="imageSources[detail.videoCoverUrl]"
          alt="视频封面"
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
        />
        <span class="video-cover__shade">
          <span class="video-cover__button">
            <LoaderCircle v-if="videoLoading" class="is-spinning" :size="20" :stroke-width="1.8" />
            <Play v-else :size="20" :stroke-width="1.8" />
          </span>
          <strong>{{ videoLoading ? "正在加载视频…" : "点击播放视频" }}</strong>
          <small>{{ videoError || "视频将在点击后下载" }}</small>
        </span>
      </button>

      <div class="detail__stats">
        <span><Heart :size="15" :stroke-width="1.8" />{{ detail.likeCount }} 个赞</span>
        <span><MessageCircle :size="15" :stroke-width="1.8" />{{ detail.commentCount }} 条评论</span>
      </div>

      <section v-if="detail.comments.length" class="comments">
        <div v-for="comment in detail.comments" :key="`${comment.uin}-${comment.createdAt}-${comment.content}`" class="comment">
          <span class="comment__avatar">
            <img
              v-if="comment.uin"
              :src="avatarUrl(comment.uin)"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
            <User v-else :size="14" :stroke-width="1.8" />
          </span>
          <div class="comment__body">
            <p class="comment__text selectable">
              <strong>{{ comment.nickname || "QQ 用户" }}</strong>
              <QzoneText :value="comment.content" />
            </p>
            <time class="comment__time">{{ formatTime(comment.createdAt) }}</time>
            <div v-if="comment.replies.length" class="comment__replies">
              <div v-for="reply in comment.replies" :key="`${reply.uin}-${reply.createdAt}-${reply.content}`" class="reply">
                <p class="comment__text selectable">
                  <strong>{{ reply.nickname || "QQ 用户" }}</strong>
                  <QzoneText :value="reply.content" />
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </article>
  </Dialog>

  <!-- --------------------------------------------------------------- 灯箱 -->
  <Teleport to="body">
    <Transition name="lightbox">
      <div
        v-if="lightboxCurrent"
        class="lightbox"
        data-qza-preview
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        @click.self="closeLightbox"
      >
        <header class="lightbox__bar">
          <div class="lightbox__caption">
            <strong>{{ lightboxCurrent.meta }}</strong>
            <span>{{ lightboxCurrent.caption }}</span>
          </div>
          <span class="lightbox__counter">{{ lightboxIndex + 1 }} / {{ lightboxList.length }}</span>
          <button class="lightbox__icon" type="button" aria-label="关闭预览（Esc）" @click="closeLightbox">
            <X :size="18" :stroke-width="1.8" />
          </button>
        </header>

        <div class="lightbox__stage">
          <button
            class="lightbox__nav"
            type="button"
            aria-label="上一张"
            :disabled="lightboxList.length < 2"
            @click="stepLightbox(-1)"
          >
            <ChevronLeft :size="20" :stroke-width="1.8" />
          </button>

          <figure class="lightbox__figure">
            <img
              v-if="imageSources[lightboxCurrent.url]"
              :src="imageSources[lightboxCurrent.url]"
              :alt="lightboxCurrent.caption"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
            <div v-else class="lightbox__fallback">
              <ImageIcon :size="24" :stroke-width="1.8" />
              <p>{{ imageLoading[lightboxCurrent.url] ? "正在加载这一张…" : "这一张暂时取不到" }}</p>
              <p v-if="imageErrors[lightboxCurrent.url]" class="lightbox__reason">{{ imageErrors[lightboxCurrent.url] }}</p>
              <button
                v-if="!imageLoading[lightboxCurrent.url]"
                class="btn btn--ghost"
                type="button"
                @click="retryLightboxImage"
              >
                <RefreshCw :size="15" :stroke-width="1.8" />
                <span>重新加载</span>
              </button>
            </div>
          </figure>

          <button
            class="lightbox__nav"
            type="button"
            aria-label="下一张"
            :disabled="lightboxList.length < 2"
            @click="stepLightbox(1)"
          >
            <ChevronRight :size="20" :stroke-width="1.8" />
          </button>
        </div>

        <footer class="lightbox__foot">
          <p class="lightbox__note">← → 切换照片，Esc 关闭</p>
          <button v-if="lightboxCurrent.item" class="btn btn--ghost" type="button" @click="openLightboxOriginal">
            <ExternalLink :size="15" :stroke-width="1.8" />
            <span>查看说说</span>
          </button>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.media-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* ------------------------------------------------------------ 页面说明区 */

.media-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  flex-wrap: wrap;
}

.media-head__intro {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  flex: 1 1 320px;
}

.media-head__badge {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--space-10);
  height: var(--space-10);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.media-head__desc {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.media-head__filter {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}

.media-head__total {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.media-head__year {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.media-head__select {
  min-width: 140px;
  max-width: 200px;
}

/* ---------------------------------------------------------------- 提示与控件 */

.banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  transition: border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.btn:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
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
  animation: media-spin 1s linear infinite;
}

@keyframes media-spin {
  to { transform: rotate(360deg); }
}

/* ---------------------------------------------------------------- 时光轴 */

.timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}

.timeline__marker {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.timeline__rule {
  flex: 1;
  height: 1px;
  background: var(--color-warm-border);
}

.timeline__count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.shot:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-sm);
}

.shot__visual img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shot__placeholder {
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

.shot__placeholder-text {
  font-size: var(--text-xs);
}

.shot__retry {
  position: relative;
  z-index: 2;
}

.shot__play {
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

.shot__hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  border: 0;
  background: transparent;
}

.shot__hit:hover {
  box-shadow: inset 0 0 0 1px var(--color-border-strong);
}

.shot__meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-3) var(--space-3);
}

.shot__meta strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shot__meta small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.shot__content {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.shot__detail {
  align-self: flex-start;
  margin-top: var(--space-1);
}

.shot__skeleton {
  aspect-ratio: 4 / 3;
  gap: 0;
}

.media-load-sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--space-16);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.sentinel-busy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.sentinel-end {
  color: var(--color-text-tertiary);
}

/* ------------------------------------------------------------ 原始动态详情 */

.detail-loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: flex-start;
}

.detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.detail__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.detail__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--space-8);
  height: var(--space-8);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.detail__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.detail__who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.detail__who strong {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.detail__who small {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.detail__content {
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.detail__pictures {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-2);
}

.detail__picture {
  display: block;
  padding: 0;
  overflow: hidden;
  aspect-ratio: 1 / 1;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  cursor: zoom-in;
}

.detail__picture img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--duration-base) var(--ease-out);
}

.detail__picture:hover img {
  transform: scale(1.03);
}

.detail__picture--pending {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.detail__video,
.video-cover {
  border-radius: var(--radius-md);
  overflow: hidden;
}

.detail__video video {
  display: block;
  width: 100%;
  max-height: 380px;
  background: var(--color-surface-sunken);
}

.video-cover {
  position: relative;
  display: block;
  width: 100%;
  min-height: 200px;
  padding: 0;
  border: var(--line-width) solid var(--color-border);
  background: var(--color-surface-sunken);
  cursor: pointer;
}

.video-cover > img {
  display: block;
  width: 100%;
  height: 240px;
  object-fit: cover;
}

.video-cover__shade {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: center;
  /* 用表面色降透明，浅色近白、深色近黑，两种主题下文字都读得清。 */
  background: color-mix(in srgb, var(--color-surface) 84%, transparent);
  color: var(--color-text);
}

.video-cover__button {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-text-inverse);
  box-shadow: var(--shadow-md);
}

.video-cover__shade strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.video-cover__shade small {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.detail__stats {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-top: var(--space-2);
  border-top: var(--line-width) solid var(--color-border);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.detail__stats span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-variant-numeric: tabular-nums;
}

.comments {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.comment {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.comment__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--space-6);
  height: var(--space-6);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-tertiary);
}

.comment__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.comment__body {
  flex: 1;
  min-width: 0;
}

.comment__text {
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.comment__text strong {
  margin-right: var(--space-2);
  font-weight: var(--weight-medium);
  color: var(--color-accent);
}

.comment__time {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.comment__replies {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-left: var(--space-3);
  border-left: var(--focus-width) solid var(--color-border);
}

/* ---------------------------------------------------------------- 灯箱 */

.lightbox {
  position: fixed;
  inset: 0;
  /* PrimeVue 的 Dialog 由 ZIndexUtils 管理（从 ~1000 起递增），灯箱要盖在详情之上。 */
  z-index: 1200;
  display: flex;
  flex-direction: column;
  background: var(--color-canvas);
}

.lightbox__bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-shrink: 0;
  padding: var(--space-4) var(--space-5);
  border-bottom: var(--line-width) solid var(--color-border);
  background: var(--color-surface);
}

.lightbox__caption {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.lightbox__caption strong {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox__caption span {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox__counter {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.lightbox__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  transition: border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.lightbox__icon:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.lightbox__stage {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
  padding: var(--space-4) var(--space-5);
}

.lightbox__nav {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--space-10);
  height: var(--space-10);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  transition: border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.lightbox__nav:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.lightbox__nav:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.lightbox__figure {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
  height: 100%;
  margin: 0;
}

.lightbox__figure img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}

.lightbox__fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-10);
  border: var(--line-width) dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  text-align: center;
}

.lightbox__reason {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  word-break: break-word;
}

.lightbox__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-shrink: 0;
  padding: var(--space-4) var(--space-5);
  border-top: var(--line-width) solid var(--color-border);
  background: var(--color-surface);
}

.lightbox__note {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}

.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}

/* ---------------------------------------------------------------- 响应式 */

@media (max-width: 1080px) {
  .media-page {
    gap: var(--space-4);
  }

  .timeline {
    gap: var(--space-6);
  }
}

@media (max-width: 860px) {
  .media-head {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-4);
  }

  .media-head__filter {
    flex-wrap: wrap;
  }

  .media-head__select {
    flex: 1;
    min-width: 0;
    max-width: none;
  }

  .shot-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }

  .lightbox__stage {
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
  }

  .lightbox__nav {
    width: var(--space-8);
    height: var(--space-8);
  }

  .lightbox__foot {
    flex-direction: column;
    align-items: stretch;
  }
}

.media-head__title {
  font-weight: var(--weight-semibold); font-size:var(--text-2xl); letter-spacing:-.025em; }
.media-head__eyebrow { color:var(--color-text-secondary); font-size:var(--text-xs); margin-bottom:var(--space-2); }
.shot-grid {
  display: grid;
  gap: var(--density-gap, var(--space-4));
  align-items: start; grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--layout-gallery-cell)),1fr)); }
.timeline__year {
  /* 暖色只用于年份标记，承担「回忆」语义。 */
  font-weight: var(--weight-semibold); font-family:var(--font-display); font-size:var(--text-2xl); font-variant-numeric:tabular-nums; color:var(--color-warm); }
.shot {
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out); content-visibility:auto; contain-intrinsic-size:auto 280px; }
.shot__visual {
  position: relative;
  aspect-ratio: 4 / 3;
  overflow: hidden; background:var(--color-photo-mat); }
@media (max-width:600px) { .shot-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-2); } .shot__meta { padding:var(--space-2); } }


/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .media-page { gap:var(--layout-page-gap); }
.media-head { align-items:center; gap:var(--space-4); }
.media-head__title { font-size:var(--text-lg); font-family:var(--font-display); letter-spacing:normal; }
.media-head__eyebrow { display:none; }
.media-head__badge { width:var(--control-height); height:var(--control-height); border-radius:var(--radius-md); }
.media-head__desc { margin-top:var(--space-1); font-size:var(--text-sm); }
.shot { box-shadow:none; border-radius:var(--radius-md); }
.shot-grid { gap:var(--space-3); }
.timeline__marker { font-size:var(--text-lg); font-variant-numeric:tabular-nums; }
@media(max-width:600px) { .media-head { align-items:flex-start; } .shot-grid { gap:var(--space-2); } }
</style>

<!-- Dialog 由 PrimeVue 渲染到 body 下，容器尺寸只能在非 scoped 作用域里约束。 -->
<style>
.media-detail {
  width: min(760px, calc(100vw - var(--space-8)));
}

.media-detail .p-dialog-content {
  max-height: min(72vh, 620px);
  overflow-y: auto;
}

@media (max-width: 860px) {
  .media-detail {
    width: calc(100vw - var(--space-4));
  }
}
</style>
