<script setup lang="ts">
import { describeError, diagnosticError } from "../utils/uiError";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import { platform } from "../utils/platform";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import Drawer from "primevue/drawer";
import Select from "primevue/select";
import {
  Calendar,
  Copy,
  List,
  LayoutGrid,
  SlidersHorizontal,
  Camera,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  Film,
  Heart,
  History,
  ImageOff,
  Images,
  LoaderCircle,
  MessageCircle,
  MessageSquareQuote,
  Play,
  RefreshCw,
  Search,
  SquareCheck,
  Trash2,
  User,
  Users,
  X,
} from "lucide-vue-next";
import ImageViewer from "../components/ImageViewer.vue";
import QzoneText from "../components/QzoneText.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import ArchiveHeading from "../components/ui/ArchiveHeading.vue";
import { useToast } from "../composables/useToast";
import { useArchiveStore } from "../stores/archive";
import { useAuthStore } from "../stores/auth";
import { ImageRequestScope, mediaFileName } from "../utils/archiveImage";
import { countArchivedFeeds, deleteArchivedFeeds, exportArchivedHtml, listArchivedFeeds, listArchiveYears, loadArchivedImage, loadArchivedVideo, type ArchiveCategory, type ArchiveItem } from "../utils/qzone";

const route = useRoute();
// 清筛选时要一并改写路由参数，否则 ?q= 会被路由 watcher 写回搜索框。
const router = useRouter();
const toast = useToast();
const archiveStore = useArchiveStore();
const authStore = useAuthStore();
const records = ref<ArchiveItem[]>([]);
function routeSearch(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function routeYear(value: unknown) {
  return typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : 0;
}
// 全局搜索会带着 ?q= 跳到本页，初始关键词直接取自路由，避免闪一次空结果。
const query = ref(routeSearch(route.query.q));
const searchKey = computed(() => query.value.trim());
const loading = ref(false);
const loadingMore = ref(false);
const deleting = ref(false);
const exporting = ref(false);
const error = ref("");
const selectedIds = ref<number[]>([]);
const confirmVisible = ref(false);
const deleteIds = ref<number[]>([]);
const loadMoreFailed = ref(false);
const first = ref(0);
const pageSize = ref(20);
const totalRecords = ref(0);
const category = ref<ArchiveCategory>("self");
const years = ref<number[]>([]);
const selectedYear = ref(routeYear(route.query.year));
const descending = ref(true);
const yearOptions = computed(() => [{ label: "全部年份", value: 0 }, ...years.value.map((year) => ({ label: `${year} 年`, value: year }))]);
const orderOptions = [
  { label: "时间从新到旧", value: true },
  { label: "时间从旧到新", value: false },
];
const categoryOptions: { label: string; value: ArchiveCategory; icon: Component; hint: string }[] = [
  { label: "我的说说", value: "self", icon: User, hint: "当前账号发布的说说" },
  { label: "其他人的说说", value: "other", icon: Users, hint: "好友及其他用户" },
];
const categoryLabel = computed(() => categoryOptions.find((item) => item.value === category.value)?.label || "备份");
const avatarTimestamp = ref(Date.now());
const videoSources = reactive<Record<number, string>>({});
const videoLoading = reactive<Record<number, boolean>>({});
const videoErrors = reactive<Record<number, string>>({});
const imageRequests = new ImageRequestScope();
const imageSources = reactive<Record<string, string>>({});
const imageLoading = reactive<Record<string, boolean>>({});
const imageErrors = reactive<Record<string, string>>({});
const imageFallbackAttempted = reactive<Record<string, boolean>>({});
const imagePreviewVisible = ref(false);
// 统一走 closeImagePreview：它还要补做被灯箱跳过的 blob 回收，不能只把可见性置 false。
const previewImageUrl = ref("");
const previewImageName = ref("qzone-image.jpg");
const expandedComments = reactive(new Set<number>());
const expandedLikes = reactive(new Set<number>());
let imageObserver: IntersectionObserver | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let routeFilterSyncPending = false;
let loadSequence = 0;
let requestedFilterSequence = -1;
let disposed = false;
const currentPlatform = platform();
const desktopPlatforms = new Set(["windows", "macos", "linux"]);
const isDesktopPlatform = desktopPlatforms.has(currentPlatform) || currentPlatform === "browser";

/* ---------------------------------------------------------------- 时间轴 */
/** 增量加载的哨兵：滚到底部时接下一页。 */
const sentinelEl = ref<HTMLElement | null>(null);
let sentinelObserver: IntersectionObserver | undefined;
let sentinelVisible = false;

const viewMode = ref<"timeline" | "cards">("timeline");
const toolsOpen = ref(false);
const refinementsOpen = ref(false);
const monthFilter = ref(0);
const fromDate = ref("");
const toDate = ref("");
const onlyPhotos = ref(false);
const onlyInteractions = ref(false);
const detailItem = ref<ArchiveItem>();
const detailOpen = ref(false);
const monthOptions = [{ label: "全部月份", value: 0 }, ...Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1} 月`, value: i + 1 }))];
const hasRefinements = computed(() => monthFilter.value > 0 || fromDate.value || toDate.value || onlyPhotos.value || onlyInteractions.value);
const filtered = computed(() => records.value.filter((item) => {
  const date = item.publishedAt ? new Date(item.publishedAt * 1000) : null;
  const localDate = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
  return (!monthFilter.value || date?.getMonth() === monthFilter.value - 1)
    && (!fromDate.value || (localDate && localDate >= fromDate.value))
    && (!toDate.value || (localDate && localDate <= toDate.value))
    && (!onlyPhotos.value || item.pictureUrls.length > 0)
    && (!onlyInteractions.value || item.likes.length > 0 || item.comments.length > 0 || item.likeCount > 0 || item.commentCount > 0);
}));
function resetRefinements() { monthFilter.value = 0; fromDate.value = ""; toDate.value = ""; onlyPhotos.value = false; onlyInteractions.value = false; }
async function copyContent(item: ArchiveItem) {
  try { await navigator.clipboard.writeText(item.content || ""); toast.success("已复制说说正文"); }
  catch { toast.error("未能复制，可以在详情中选中正文复制"); }
}
const visibleIds = computed(() => filtered.value.map((item) => item.id));
const allVisibleSelected = computed(() => visibleIds.value.length > 0 && visibleIds.value.every((id) => selectedIds.value.includes(id)));
const hasMore = computed(() => records.value.length < totalRecords.value);
const confirmTitle = computed(() => `删除 ${deleteIds.value.length} 条备份？`);
const canDelete = computed(() => authStore.loggedIn && !archiveStore.busy && !loading.value && !deleting.value);
const confirmDescription = "所选记录将从本机永久删除，不会删除 QQ 空间中的内容。此操作无法撤销。";
const formatTime = (seconds: number) => seconds ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000)) : "时间未知";
const yearStamp = (seconds: number) => seconds ? String(new Date(seconds * 1000).getFullYear()) : "年份未知";
const dayStamp = (seconds: number) => {
  if (!seconds) return "--";
  const date = new Date(seconds * 1000);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
/** 同一年只标一次年份，形成时间轴上的年份刻度。 */
const timeline = computed(() => {
  let previous = "";
  return filtered.value.map((record) => {
    const year = yearStamp(record.publishedAt);
    const entry = { ...record, day: dayStamp(record.publishedAt), year, yearLabel: year === previous ? "" : year };
    previous = year;
    return entry;
  });
});
const avatarUrl = (uin?: string) => uin ? `https://qlogo2.store.qq.com/qzone/${uin}/${uin}/50?${avatarTimestamp.value}` : "";
const historicalLikes = (item: ArchiveItem) => item.likes.filter((like) => like.historical);
const visibleLikes = (item: ArchiveItem) => expandedLikes.has(item.id) ? item.likes : item.likes.slice(0, 10);
const likeTitle = (like: ArchiveItem["likes"][number]) => [
  like.uin ? `QQ ${like.uin}` : "QQ 号未保留",
  like.likedAt ? `点赞于 ${formatTime(like.likedAt)}` : "点赞时间未知",
  like.historical ? "来源：历史互动记录" : "来源：当前空间接口",
].join(" · ");

const hasFilter = computed(() => Boolean(query.value.trim()) || selectedYear.value > 0);
const emptyTitle = computed(() => hasFilter.value ? "没有符合条件的说说" : "还没有备份任何说说");
const emptyDescription = computed(() => hasFilter.value
  ? "试试其他关键词或年份。"
  : "到「恢复任务」开始保存说说。");

async function load() {
  if (disposed) return;
  if (searchTimer !== undefined) { clearTimeout(searchTimer); searchTimer = undefined; }
  const sequence = ++loadSequence;
  requestedFilterSequence = sequence;
  releaseVideos();
  loadingMore.value = false;
  loadMoreFailed.value = false;
  selectedIds.value = [];
  if (!deleting.value) { confirmVisible.value = false; deleteIds.value = []; }
  loading.value = true; error.value = "";
  try {
    const year = selectedYear.value || undefined;
    const search = searchKey.value || undefined;
    const [items, total, availableYears] = await Promise.all([
      listArchivedFeeds(pageSize.value, 0, category.value, year, descending.value, search),
      countArchivedFeeds(category.value, year, search),
      listArchiveYears(category.value),
    ]);
    if (sequence !== loadSequence) return;
    // 这里不再刷新 avatarTimestamp：load() 会被搜索、翻页、筛选频繁触发，每次重取时间戳都会让整屏头像重新下载。
    records.value = items; totalRecords.value = total; selectedIds.value = [];
    first.value = items.length;
    years.value = availableYears;
    if (selectedYear.value && !availableYears.includes(selectedYear.value)) selectedYear.value = 0;
    if (sequence !== loadSequence) return;
    // The timeline is hidden while loading; observe only after it has rendered.
    loading.value = false;
    await nextTick();
    if (sequence === loadSequence) observeArchiveImages();
  }
  catch (reason) { if (sequence === loadSequence) error.value = String(reason); }
  finally { if (sequence === loadSequence) { loading.value = false; void ensureFilled(); } }
}
/** 追加下一页；由滚动哨兵触发，也可手动调用。 */
async function loadMore() {
  if (disposed || loading.value || loadingMore.value || !hasMore.value) return;
  const sequence = loadSequence;
  loadingMore.value = true;
  loadMoreFailed.value = false;
  error.value = "";
  try {
    const year = selectedYear.value || undefined;
    const search = searchKey.value || undefined;
    const items = await listArchivedFeeds(pageSize.value, first.value, category.value, year, descending.value, search);
    if (sequence !== loadSequence) return;
    if (!items.length) { totalRecords.value = records.value.length; return; }
    const known = new Set(records.value.map((record) => record.id));
    const fresh = items.filter((record) => !known.has(record.id));
    first.value += items.length;
    if (!fresh.length) { totalRecords.value = records.value.length; return; }
    records.value = [...records.value, ...fresh];
    await nextTick();
    if (sequence === loadSequence) observeArchiveImages();
  }
  catch (reason) {
    if (sequence === loadSequence) { loadMoreFailed.value = true; error.value = String(reason); }
  }
  finally { if (sequence === loadSequence) { loadingMore.value = false; void ensureFilled(); } }
}
/** 首页不足一屏时哨兵一直可见，滚动不会产生新交叉事件，这里主动补齐。 */
async function ensureFilled() {
  await nextTick();
  if (disposed || error.value || loadMoreFailed.value || hasRefinements.value || !sentinelVisible || !hasMore.value || loading.value || loadingMore.value) return;
  void loadMore();
}
function observeSentinel() {
  if (disposed) return;
  sentinelObserver?.disconnect();
  sentinelVisible = false;
  const element = sentinelEl.value;
  if (!element) return;
  sentinelObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      sentinelVisible = entry.isIntersecting;
      if (entry.isIntersecting && !error.value && !loadMoreFailed.value) void loadMore();
    }
  }, { rootMargin: "320px 0px" });
  sentinelObserver.observe(element);
}
/**
 * 灯箱（Teleport 到 body）和卡片共用同一批 blob：灯箱正显示或待左右切换的那几张不能被回收，
 * 否则大图会变白、「保存图片」也会失败。只跳过被灯箱持有的地址，其余照常释放。
 */
function isHeldByLightbox(blobUrl: string) {
  if (!imagePreviewVisible.value) return false;
  if (previewImageUrl.value === blobUrl) return true;
  return previewSources.value.some((entry) => entry.source === blobUrl);
}
function releaseVideos() {
  imageRequests.clear();
  imageObserver?.disconnect();
  Object.values(videoSources).forEach((url) => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
  Object.keys(videoSources).forEach((key) => delete videoSources[Number(key)]);
  Object.keys(videoLoading).forEach((key) => delete videoLoading[Number(key)]);
  Object.keys(videoErrors).forEach((key) => delete videoErrors[Number(key)]);
  Object.values(imageSources).forEach((url) => { if (url.startsWith("blob:") && !isHeldByLightbox(url)) URL.revokeObjectURL(url); });
  Object.keys(imageSources).forEach((key) => delete imageSources[key]);
  Object.keys(imageLoading).forEach((key) => delete imageLoading[key]);
  Object.keys(imageErrors).forEach((key) => delete imageErrors[key]);
  Object.keys(imageFallbackAttempted).forEach((key) => delete imageFallbackAttempted[key]);
}
function observeArchiveImages() {
  if (disposed) return;
  imageObserver?.disconnect();
  imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target as HTMLElement;
      const url = element.dataset.archiveImage;
      const dynamicId = Number(element.dataset.dynamicId);
      const pictureIndex = Number(element.dataset.pictureIndex);
      if (url) void loadArchiveImage(url, Number.isFinite(dynamicId) ? dynamicId : undefined, Number.isFinite(pictureIndex) ? pictureIndex : undefined);
      imageObserver?.unobserve(element);
    }
  }, { rootMargin: "240px 0px" });
  document.querySelectorAll<HTMLElement>(".archive-page [data-archive-image]").forEach((element) => imageObserver?.observe(element));
}
async function loadArchiveImage(url: string, dynamicId?: number, pictureIndex?: number) {
  if (disposed || !url || imageSources[url] || imageLoading[url]) return;
  const generation = imageRequests.generation;
  imageLoading[url] = true;
  delete imageErrors[url];
  delete imageFallbackAttempted[url];
  try {
    if (dynamicId !== undefined && pictureIndex !== undefined) {
      try {
        const source = convertFileSrc(await loadArchivedImage(dynamicId, pictureIndex));
        if (generation !== imageRequests.generation) return;
        imageSources[url] = source;
        return;
      } catch (reason) {
        if (generation !== imageRequests.generation) return;
        console.warn("本地图片备份加载失败，改用原始地址", reason);
      }
    }
    await loadRemoteArchiveImage(url);
  } catch (reason) { if (generation === imageRequests.generation) imageErrors[url] = String(reason); }
  finally { if (generation === imageRequests.generation) imageLoading[url] = false; }
}
async function loadRemoteArchiveImage(url: string) {
  const generation = imageRequests.generation;
  const source = await imageRequests.load(url);
  if (generation === imageRequests.generation) imageSources[url] = source;
  else URL.revokeObjectURL(source);
}
async function handleArchiveImageError(url: string) {
  if (!url || imageLoading[url]) return;
  const source = imageSources[url];
  // 这张图可能正被灯箱显示：此时只解除卡片绑定，不能回收灯箱还在用的 blob。
  if (source?.startsWith("blob:") && !isHeldByLightbox(source)) URL.revokeObjectURL(source);
  delete imageSources[url];
  if (imageFallbackAttempted[url]) {
    imageErrors[url] = "图片文件无法显示，可点击重试";
    return;
  }
  const generation = imageRequests.generation;
  imageFallbackAttempted[url] = true;
  imageLoading[url] = true;
  try { await loadRemoteArchiveImage(url); }
  catch (reason) { if (generation === imageRequests.generation) imageErrors[url] = String(reason); }
  finally { if (generation === imageRequests.generation) imageLoading[url] = false; }
}
function imageExtension(url: string) {
  const match = url.match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
  const extension = match?.[1]?.toLowerCase();
  return extension && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension) ? extension : "jpg";
}
function openImagePreview(sourceUrl: string, originalUrl: string, cellId: string, index: number) {
  previewImageUrl.value = sourceUrl;
  previewImageName.value = mediaFileName(records.value.find(item => item.cellId === cellId)?.publishedAt || detailItem.value?.publishedAt || 0, `${cellId}-${index + 1}`, imageExtension(originalUrl));

  imagePreviewVisible.value = true;
}
/** 灯箱的左右切换需要知道同一条说说里还有哪些已就绪的图片。 */
interface PreviewEntry { source: string; original: string; cellId: string; index: number; }
const previewSources = ref<PreviewEntry[]>([]);
const previewIndex = ref(0);
function openPicturePreview(item: ArchiveItem, pictureIndex: number) {
  const ready = item.pictureUrls
    .slice(0, 4)
    .map((url, index) => ({ url, index, source: imageSources[url] as string | undefined }))
    .filter((entry): entry is { url: string; index: number; source: string } => Boolean(entry.source));
  const position = ready.findIndex((entry) => entry.index === pictureIndex);
  if (position < 0) return;
  previewSources.value = ready.map((entry) => ({ source: entry.source, original: entry.url, cellId: item.cellId, index: entry.index }));
  previewIndex.value = position;
  const current = ready[position];
  openImagePreview(current.source, current.url, item.cellId, current.index);
}
function stepImagePreview(step: number) {
  const list = previewSources.value;
  if (list.length < 2) return;
  const next = (previewIndex.value + step + list.length) % list.length;
  previewIndex.value = next;
  const entry = list[next];
  openImagePreview(entry.source, entry.original, entry.cellId, entry.index);
}
function releaseDetachedPreviewBlobs() {
  const used = new Set(Object.values(imageSources));
  previewSources.value.forEach(entry => { if (entry.source.startsWith("blob:") && !used.has(entry.source)) URL.revokeObjectURL(entry.source); });
}
function closeImagePreview() { imagePreviewVisible.value = false; releaseDetachedPreviewBlobs(); }
async function exportHtml(selectedOnly: boolean) {
  if (disposed || exporting.value || loading.value || (selectedOnly && !selectedIds.value.length)) return;
  const account = authStore.user?.uin;
  const isCurrentAccount = () => !disposed && account === authStore.user?.uin;
  exporting.value = true; error.value = "";
  try {
    const exportCategory = category.value;
    const exportIds = selectedOnly ? [...selectedIds.value] : undefined;
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `QQ空间恢复备份-${categoryLabel.value}-${date}.html`,
      filters: [{ name: "HTML 网页", extensions: ["html"] }],
    });
    if (!path || !isCurrentAccount()) return;
    const result = await exportArchivedHtml(exportCategory, path, exportIds);
    if (!isCurrentAccount()) return;
    const mediaNote = result.mediaFiles > 0 ? "移动时请将网页和旁边的媒体文件夹一起带走。" : "文字和互动记录可离线查看。";
    const summary = `已导出 ${result.records} 条记录和 ${result.mediaFiles} 个媒体文件。${mediaNote}`;
    if (result.missingMedia > 0) toast.info(`${summary}另有 ${result.missingMedia} 个媒体尚未保存，已在网页中标注。`);
    else toast.success(summary);
  } catch (reason) { if (isCurrentAccount()) error.value = `导出失败：${String(reason)}`; }
  finally { if (!disposed) exporting.value = false; }
}
async function loadVideo(item: ArchiveItem) {
  if (!item.videoUrl || videoLoading[item.id]) return;
  const generation = imageRequests.generation;
  videoLoading[item.id] = true; delete videoErrors[item.id];
  try {
    const path = await loadArchivedVideo(item.id);
    if (generation !== imageRequests.generation) return;
    videoSources[item.id] = convertFileSrc(path);
    await nextTick();
    if (generation !== imageRequests.generation) return;
    const video = document.querySelector<HTMLVideoElement>(`#archive-video-${item.id}`);
    if (!video) throw new Error("视频播放器创建失败");
    await video.play().catch((reason) => { throw new Error(`播放器无法播放该视频：${String(reason)}`); });
  } catch (reason) { if (generation === imageRequests.generation) videoErrors[item.id] = `视频加载失败：${String(reason)}`; }
  finally { if (generation === imageRequests.generation) videoLoading[item.id] = false; }
}
function toggleVisible() {
  const visible = new Set(visibleIds.value);
  selectedIds.value = allVisibleSelected.value ? selectedIds.value.filter((id) => !visible.has(id)) : [...new Set([...selectedIds.value, ...visible])];
}
function askDelete() {
  if (disposed || !canDelete.value || !selectedIds.value.length) return;
  const ids = [...new Set(selectedIds.value)];
  if (ids.length > 500) { error.value = "单次最多删除 500 条说说，请减少选择后重试。"; return; }
  error.value = "";
  deleteIds.value = ids;
  confirmVisible.value = true;
}
function toggleComments(id: number) { expandedComments.has(id) ? expandedComments.delete(id) : expandedComments.add(id); }
/**
 * 顶部全局搜索会把 ?q= / ?year= 带到本页。本地清筛选后必须一并清掉路由参数，
 * 否则路由 watcher 会在 flush 后把关键词写回，用户会看到列表又跳回搜索结果。
 */
async function dropRouteFilters() {
  if (routeFilterSyncPending || (!route.query.q && !route.query.year)) return;
  routeFilterSyncPending = true;
  try {
    // Category resets can be followed by a new draft in the same event. Write
    // the settled filters so the route echo cannot restore an earlier reset.
    await nextTick();
    if (disposed) return;
    const nextQuery = { ...route.query };
    if (searchKey.value) nextQuery.q = searchKey.value;
    else delete nextQuery.q;
    if (selectedYear.value) nextQuery.year = String(selectedYear.value);
    else delete nextQuery.year;
    await router.replace({ query: nextQuery });
  } catch (reason) {
    if (!disposed) toast.error(describeError(reason, "筛选已更改，但页面地址未能更新。"));
  } finally { routeFilterSyncPending = false; }
}
function clearFilters() { query.value = ""; selectedYear.value = 0; dropRouteFilters(); }
function dismissError() { error.value = ""; }
async function confirmDelete() {
  if (disposed || !canDelete.value || !confirmVisible.value || !deleteIds.value.length) return;
  const ids = [...deleteIds.value];
  const account = authStore.user?.uin;
  const isCurrentAccount = () => !disposed && account === authStore.user?.uin;
  deleting.value = true; error.value = "";
  try {
    const removed = await deleteArchivedFeeds(ids);
    if (!isCurrentAccount()) return;
    confirmVisible.value = false;
    deleteIds.value = [];
    selectedIds.value = selectedIds.value.filter(id => !ids.includes(id));
    toast.success(`已删除 ${removed} 条备份记录`);
    await load();
  } catch (reason) { if (isCurrentAccount()) error.value = String(reason); }
  finally { if (!disposed) deleting.value = false; }
}
onMounted(() => {

  void load();
});
// Stop old pages immediately, including the search debounce window.
watch([category, selectedYear, descending, searchKey], () => {
  ++loadSequence;
  loading.value = true;
  loadingMore.value = false;
  loadMoreFailed.value = false;
  error.value = "";
  selectedIds.value = [];
  confirmVisible.value = false;
  deleteIds.value = [];
  records.value = [];
  totalRecords.value = 0;
  first.value = 0;
  detailOpen.value = false;
  detailItem.value = undefined;
  closeImagePreview();
  releaseVideos();
}, { flush: "sync" });
watch(sentinelEl, () => observeSentinel(), { flush: "post" });
watch(category, () => {
  query.value = "";
  selectedYear.value = 0;
  dropRouteFilters();
}, { flush: "sync" });
// Batch a route update/category reset into one request. Only typing is delayed;
// changing year/order or manually refreshing cancels the pending typing request.
watch([category, selectedYear, descending, searchKey], (current, previous) => {
  if (disposed) return;
  if (searchTimer !== undefined) { clearTimeout(searchTimer); searchTimer = undefined; }
  if (requestedFilterSequence === loadSequence) return;
  const onlySearch = current[0] === previous[0] && current[1] === previous[1] && current[2] === previous[2];
  if (!onlySearch) { void load(); return; }
  searchTimer = setTimeout(() => { searchTimer = undefined; void load(); }, 260);
});
// 顶栏的全局搜索会把关键词带过来，本页已在路由中时也要跟着更新。
watch(
  [() => route.query.q, () => route.query.year],
  ([search, year]) => {
    query.value = routeSearch(search);
    selectedYear.value = routeYear(year);
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  disposed = true;
  ++loadSequence;
  closeImagePreview();
  if (searchTimer) clearTimeout(searchTimer);

  imageObserver?.disconnect();
  sentinelObserver?.disconnect();

  releaseVideos();
});
</script>

<template>
  <div class="archive-page" :class="isDesktopPlatform ? 'platform-desktop' : 'platform-mobile'">
    <ArchiveHeading title="说说" description="按年份或关键词查找已保存的说说。" :icon="History" />
    <!-- ------------------------------------------------------------ 工具条 -->
    <SectionCard class="ar-toolbar">
      <div class="ar-row">
        <div class="ar-segments" role="group" aria-label="备份分类">
          <button
            v-for="option in categoryOptions"
            :key="option.value"
            type="button"
            class="ar-segment"
            :class="{ 'is-active': category === option.value }"
            :title="option.hint"
            :aria-label="option.label"
            :aria-pressed="category === option.value"
            @click="category = option.value"
          >
            <component :is="option.icon" :size="15" :stroke-width="1.8" />
            <span class="ar-category-label">{{ option.label }}</span>
            <span class="ar-category-short">{{ option.value === 'self' ? '我的' : '其他' }}</span>
          </button>
        </div>

        <label class="ar-search">
          <Search :size="15" :stroke-width="1.8" aria-hidden="true" />
          <input v-model="query" type="search" placeholder="搜索内容、昵称或 QQ 号" aria-label="搜索备份内容" />
          <button v-if="query" type="button" class="ar-search__clear" aria-label="清除搜索" @click.prevent="query = ''">
            <X :size="13" :stroke-width="1.8" />
          </button>
        </label>

        <div class="ar-filters">
          <Select v-model="selectedYear" :options="yearOptions" option-label="label" option-value="value" size="small" aria-label="按年份筛选" />
          <Select v-model="descending" :options="orderOptions" option-label="label" option-value="value" size="small" aria-label="按时间排序" />
        </div>

        <div class="ar-quick">
          <button type="button" class="ar-btn is-icon" :aria-label="loading ? '正在刷新' : '刷新'" :disabled="loading" @click="load">
            <RefreshCw :size="16" :stroke-width="1.8" :class="{ 'is-spinning': loading }" />
          </button>
          <RouterLink class="ar-btn is-icon" to="/media" title="说说媒体" aria-label="打开说说媒体">
            <Camera :size="16" :stroke-width="1.8" />
          </RouterLink>
        </div>
      </div>

      <div class="ar-row ar-row--meta">
        <p class="ar-count">
          <Calendar :size="14" :stroke-width="1.8" />
          <template v-if="loading">正在读取…</template>
          <template v-else-if="error">数量尚未读取</template>
          <template v-else>
            <span><strong>{{ totalRecords }}</strong> 条<span class="ar-count__category">{{ categoryLabel }}</span></span>
            <span v-if="records.length < totalRecords">已加载 {{ records.length }} 条</span>
          </template>
        </p>
        <button class="ar-btn ar-mobile-tools" type="button" :aria-expanded="toolsOpen" aria-controls="archive-extra-tools" @click="toolsOpen = !toolsOpen">
          <SlidersHorizontal :size="15" :stroke-width="1.8" />
          <span>{{ selectedIds.length ? `已选 ${selectedIds.length} 条` : hasRefinements ? '筛选已开启' : '筛选与导出' }}</span>
          <ChevronDown :size="14" :stroke-width="1.8" />
        </button>
      </div>
      <div id="archive-extra-tools" class="ar-extra-tools" :class="{ 'is-open': toolsOpen }">
        <div class="ar-view-tools">
          <div class="ar-segments" role="group" aria-label="展示方式"><button class="ar-btn" type="button" :aria-pressed="viewMode === 'timeline'" @click="viewMode = 'timeline'"><List :size="15" :stroke-width="1.8" />时间轴</button><button class="ar-btn" type="button" :aria-pressed="viewMode === 'cards'" @click="viewMode = 'cards'"><LayoutGrid :size="15" :stroke-width="1.8" />卡片</button></div>
          <button class="ar-btn" type="button" :aria-expanded="refinementsOpen" aria-controls="archive-refinements" @click="refinementsOpen = !refinementsOpen"><SlidersHorizontal :size="15" :stroke-width="1.8" /><span>筛选已加载内容{{ hasRefinements ? ' · 已开启' : '' }}</span></button>
        </div>
        <div v-show="refinementsOpen" id="archive-refinements" class="ar-refinements">
          <p>以下条件仅筛选已加载的 {{ records.length }} 条。查找全部备份请使用上方的年份和搜索。</p>
          <div class="ar-refinements__fields"><Select v-model="monthFilter" :options="monthOptions" option-label="label" option-value="value" aria-label="月份（已加载内容）" /><label>开始日期<input v-model="fromDate" type="date" :max="toDate || undefined" /></label><label>结束日期<input v-model="toDate" type="date" :min="fromDate || undefined" /></label><label><input v-model="onlyPhotos" type="checkbox" />仅有图片</label><label><input v-model="onlyInteractions" type="checkbox" />仅有互动</label><button class="ar-btn" type="button" @click="resetRefinements">重置筛选已加载内容</button></div>
        </div>
        <div class="ar-row ar-row--meta">
          <div class="ar-bulk">
            <button v-if="records.length" type="button" class="ar-btn" @click="toggleVisible">
              <SquareCheck :size="15" :stroke-width="1.8" />
              <span>{{ allVisibleSelected ? "取消选择" : `选择已显示的 ${visibleIds.length} 条` }}</span>
            </button>
            <span v-if="selectedIds.length" class="ar-pill">已选 {{ selectedIds.length }} 条</span>
            <button v-if="selectedIds.length" type="button" class="ar-btn" :disabled="exporting || loading" @click="exportHtml(true)">
              <Download :size="15" :stroke-width="1.8" />
              <span>导出所选</span>
            </button>
            <button v-if="selectedIds.length" type="button" class="ar-btn is-danger" :disabled="!canDelete" @click="askDelete">
              <Trash2 :size="15" :stroke-width="1.8" />
              <span>删除所选</span>
            </button>
            <span class="ar-bulk__divider" aria-hidden="true" />
            <button type="button" class="ar-btn" title="导出此分类的全部说说，不受年份和搜索条件限制" :disabled="!totalRecords || loading || exporting" @click="exportHtml(false)">
              <Download :size="15" :stroke-width="1.8" />
              <span>{{ exporting ? "正在导出…" : `导出全部${categoryLabel}` }}</span>
            </button>
          </div>
        </div>
      </div>
    </SectionCard>

    <!-- ------------------------------------------------------------ 错误 -->
    <div v-if="error && records.length" class="ar-errorbar" role="alert">
      <CircleAlert :size="16" :stroke-width="1.8" />
      <span class="ar-errorbar__text">{{ describeError(error, "备份读取没有完成，请重试。") }}</span>
      <button type="button" class="ar-btn" @click="loadMoreFailed ? loadMore() : load()">重试</button>
      <button type="button" class="ar-btn is-ghost" @click="dismissError">关闭提示</button>
    </div>

    <!-- ---------------------------------------------------------- 骨架屏 -->
    <div v-if="loading" class="ar-timeline" aria-hidden="true">
      <div v-for="index in 4" :key="index" class="ar-entry">
        <div class="ar-rail">
          <div class="ar-stamp"><SkeletonBlock width="42px" height="12px" /><SkeletonBlock width="28px" height="10px" /></div>
        </div>
        <div class="ar-card is-skeleton">
          <div class="ar-skeleton-head">
            <SkeletonBlock width="36px" circle />
            <div class="ar-skeleton-copy"><SkeletonBlock width="110px" height="12px" /><SkeletonBlock width="170px" height="10px" /></div>
          </div>
          <SkeletonBlock :lines="3" height="14px" />
          <div class="ar-skeleton-grid">
            <SkeletonBlock v-for="cell in 3" :key="cell" height="104px" />
          </div>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------ 整页错误态 -->
    <SectionCard v-else-if="error && !records.length" flush>
      <EmptyState
        :icon="CircleAlert"
        tone="danger"
        title="备份读取失败"
        description="请重试，或到「恢复任务」查看当前状态。"
      >
        <button type="button" class="ar-btn is-primary" @click="load">
          <RefreshCw :size="16" :stroke-width="1.8" />
          <span>重试</span>
        </button>
        <RouterLink class="ar-btn" to="/tasks">
          <span>查看恢复任务</span>
        </RouterLink>
      </EmptyState>
      <details class="ar-details">
        <summary>错误详情</summary>
        <p>{{ diagnosticError(error) }}</p>
      </details>
    </SectionCard>

    <!-- ------------------------------------------------------------ 空态 -->
    <SectionCard v-else-if="!filtered.length" flush>
      <EmptyState v-if="hasRefinements" :icon="Search" title="已加载的内容中没有匹配项" description="重置筛选已加载内容，或继续读取下一批备份再查找。"><button class="ar-btn" type="button" @click="resetRefinements">重置筛选已加载内容</button><button v-if="hasMore" class="ar-btn is-primary" type="button" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '正在读取…' : '读取下一批' }}</button></EmptyState>
      <EmptyState v-else :icon="MessageSquareQuote" tone="warm" :title="emptyTitle" :description="emptyDescription">
        <button v-if="hasFilter" type="button" class="ar-btn is-primary" @click="clearFilters">
          <span>清除筛选</span>
        </button>
        <RouterLink v-else class="ar-btn is-primary" to="/tasks">
          <RefreshCw :size="16" :stroke-width="1.8" />
          <span>去恢复任务</span>
        </RouterLink>
      </EmptyState>
    </SectionCard>

    <!-- ---------------------------------------------------------- 时间轴 -->
    <div v-else class="ar-timeline" :class="{ 'is-cards': viewMode === 'cards' }">
      <article v-for="item in timeline" :key="item.id" class="ar-entry">
        <h3 v-if="item.yearLabel" class="ar-year">
          <Calendar :size="14" :stroke-width="1.8" />
          <span>{{ item.yearLabel }}</span>
        </h3>

        <div class="ar-rail">
          <span class="ar-node" aria-hidden="true" />
          <div class="ar-stamp">
            <strong>{{ item.day }}</strong>
            <em>{{ item.year }}</em>
          </div>
        </div>

        <div class="ar-card" :class="{ 'is-selected': selectedIds.includes(item.id) }">
          <header class="ar-head">
            <span class="ar-avatar">
              <img v-if="item.authorUin" :src="avatarUrl(item.authorUin)" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              <User v-else :size="16" :stroke-width="1.8" />
            </span>
            <div class="ar-publisher">
              <strong>{{ item.authorName || "我" }}</strong>
              <span>
                <span v-if="item.authorUin" class="ar-publisher__uin">QQ {{ item.authorUin }}</span>
                <time>{{ formatTime(item.publishedAt) }}</time>
              </span>
            </div>
            <Checkbox v-model="selectedIds" :input-id="`archive-${item.id}`" :value="item.id" :aria-label="`选择 ${formatTime(item.publishedAt)} 的说说`" />
          </header>

          <p class="ar-content selectable"><QzoneText :value="item.content" /></p>
          <div class="ar-record-actions"><button class="ar-link" type="button" @click="detailItem = item; detailOpen = true">查看详情<ChevronRight :size="14" :stroke-width="1.8" /></button><button class="ar-link" type="button" :disabled="!item.content" @click="copyContent(item)"><Copy :size="14" :stroke-width="1.8" />复制正文</button></div>

          <div v-if="item.pictureUrls.length" class="ar-pictures" :class="`is-${Math.min(item.pictureUrls.length, 4)}`">
            <template v-for="(url, pictureIndex) in item.pictureUrls.slice(0, 4)" :key="url">
              <button v-if="imageSources[url]" type="button" class="ar-picture" :aria-label="`查看第 ${pictureIndex + 1} 张图片`" @click="openPicturePreview(item, pictureIndex)">
                <img :src="imageSources[url]" :alt="`说说图片 ${pictureIndex + 1}`" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="handleArchiveImageError(url)" />
              </button>
              <div v-else class="ar-picture-pending" :data-archive-image="url" :data-dynamic-id="item.id" :data-picture-index="pictureIndex">
                <ImageOff v-if="imageErrors[url]" :size="18" :stroke-width="1.8" />
                <LoaderCircle v-else :size="18" :stroke-width="1.8" :class="{ 'is-spinning': imageLoading[url] }" />
                <button v-if="imageErrors[url]" type="button" class="ar-retry" :title="imageErrors[url]" @click.stop="loadArchiveImage(url, item.id, pictureIndex)">重试</button>
                <span v-else>{{ imageLoading[url] ? "正在加载" : "等待加载" }}</span>
              </div>
            </template>
            <span v-if="item.pictureUrls.length > 4" class="ar-picture-more">+{{ item.pictureUrls.length - 4 }}</span>
          </div>

          <video v-if="videoSources[item.id]" :id="`archive-video-${item.id}`" class="ar-video" :src="videoSources[item.id]" controls preload="metadata" playsinline />
          <div v-else-if="item.videoUrl" class="ar-video-cover" :class="{ 'is-loading': videoLoading[item.id] }" :data-archive-image="item.videoCoverUrl || undefined" role="button" tabindex="0" @click="loadVideo(item)" @keydown.enter="loadVideo(item)">
            <img v-if="item.videoCoverUrl && imageSources[item.videoCoverUrl]" :src="imageSources[item.videoCoverUrl]" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="handleArchiveImageError(item.videoCoverUrl)" />
            <div class="ar-video-shade">
              <span class="ar-video-play">
                <LoaderCircle v-if="videoLoading[item.id]" class="is-spinning" :size="20" :stroke-width="1.8" />
                <Play v-else :size="20" :stroke-width="1.8" />
              </span>
              <strong>{{ videoLoading[item.id] ? "正在加载视频…" : "点击播放" }}</strong>
              <small>{{ videoErrors[item.id] ? describeError(videoErrors[item.id], '视频加载失败，点击重试。') : "点击后下载并播放" }}</small>
            </div>
          </div>

          <div class="ar-assets">
            <span v-if="item.likes.length" class="ar-likes">
              <Heart :size="13" :stroke-width="1.8" />
              <span class="ar-like-names"><template v-for="(like, likeIndex) in visibleLikes(item)" :key="`${like.uin}-${like.likedAt}-${likeIndex}`"><span class="ar-like-person" :class="{ 'is-historical': like.historical }" :title="likeTitle(like)">{{ like.nickname || like.uin || 'QQ用户' }}</span><span v-if="likeIndex < visibleLikes(item).length - 1">、</span></template></span>
              <span>赞了</span>
              <button v-if="item.likes.length > 10" type="button" class="ar-link" :aria-expanded="expandedLikes.has(item.id)" @click="expandedLikes.has(item.id) ? expandedLikes.delete(item.id) : expandedLikes.add(item.id)">{{ expandedLikes.has(item.id) ? '收起' : `等 ${item.likes.length} 人赞了` }}</button>
            </span>
            <span v-if="historicalLikes(item).length" class="ar-like-note">
              <History :size="13" :stroke-width="1.8" />
              <span>其中 {{ historicalLikes(item).length }} 人来自历史互动记录，名单可能不完整。</span>
            </span>
            <span v-if="item.commentCount"><MessageCircle :size="13" :stroke-width="1.8" />{{ item.commentCount }} 条评论</span>
            <span v-if="item.pictureUrls.length"><Images :size="13" :stroke-width="1.8" />{{ item.pictureUrls.length }} 张图片</span>
            <span v-if="item.videoUrl"><Film :size="13" :stroke-width="1.8" />视频</span>
          </div>

          <section v-if="item.comments.length" class="ar-comments">
            <div v-for="comment in (expandedComments.has(item.id) ? item.comments : item.comments.slice(0, 3))" :key="`${comment.uin}-${comment.createdAt}-${comment.content}`" class="ar-comment">
              <span class="ar-avatar is-small">
                <img v-if="comment.uin" :src="avatarUrl(comment.uin)" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
                <User v-else :size="13" :stroke-width="1.8" />
              </span>
              <div class="ar-comment-body">
                <div class="ar-comment-meta">
                  <strong :title="comment.uin ? `QQ ${comment.uin}` : undefined">{{ comment.nickname || comment.uin || "QQ 用户" }}</strong>
                  <span>评论于</span>
                  <time>{{ formatTime(comment.createdAt) }}</time>
                </div>
                <p><QzoneText :value="comment.content" /></p>
                <div v-if="comment.replies.length" class="ar-replies">
                  <div v-for="(reply, replyIndex) in comment.replies" :key="`${reply.uin}-${reply.createdAt}-${replyIndex}`" class="ar-reply">
                    <span class="ar-avatar is-tiny">
                      <img v-if="reply.uin" :src="avatarUrl(reply.uin)" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
                      <User v-else :size="12" :stroke-width="1.8" />
                    </span>
                    <div class="ar-comment-body">
                      <div class="ar-comment-meta">
                        <strong :title="reply.uin ? `QQ ${reply.uin}` : undefined">{{ reply.nickname || reply.uin || "QQ 用户" }}</strong>
                        <span>回复 {{ reply.replyToNickname || reply.replyToUin || comment.nickname || comment.uin || "QQ 用户" }}</span>
                        <time>{{ formatTime(reply.createdAt) }}</time>
                      </div>
                      <p><QzoneText :value="reply.content" /></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <button v-if="item.comments.length > 3" type="button" class="ar-link is-strong" :class="{ 'is-open': expandedComments.has(item.id) }" @click="toggleComments(item.id)">
              <span>{{ expandedComments.has(item.id) ? '收起评论' : `查看全部 ${item.comments.length} 条评论` }}</span>
              <ChevronDown class="ar-link__chevron" :size="14" :stroke-width="1.8" />
            </button>
          </section>
        </div>
      </article>
    </div>

    <!-- ---------------------------------------------------------- 增量加载 -->
    <div v-if="!loading && !error && hasMore && !hasRefinements" ref="sentinelEl" class="ar-sentinel">
      <LoaderCircle v-if="loadingMore" class="is-spinning" :size="18" :stroke-width="1.8" />
      <span>{{ loadingMore ? "正在读取更早的说说…" : "继续向下滚动加载" }}</span>
    </div>
    <div v-else-if="!loading && !error && hasMore && filtered.length" class="ar-sentinel"><button class="ar-btn" type="button" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '正在读取…' : '读取下一批' }}</button></div>
    <p v-else-if="!loading && !error && !hasMore && records.length" class="ar-end">已经到底了 · 共 {{ totalRecords }} 条</p>

    <!-- ---------------------------------------------------------- 确认删除 -->
    <Drawer v-model:visible="detailOpen" position="right" header="说说详情" aria-label="说说详情" class="archive-detail">
      <div v-if="detailItem" class="ar-detail">
        <p class="ar-detail__date">{{ formatTime(detailItem.publishedAt) }} · {{ detailItem.authorName || 'QQ 用户' }}</p>
        <p class="ar-detail__text selectable"><QzoneText :value="detailItem.content" /></p>
        <button class="ar-btn" type="button" :disabled="!detailItem.content" @click="copyContent(detailItem)"><Copy :size="15" :stroke-width="1.8" />复制正文</button>
        <div v-for="(url, index) in detailItem.pictureUrls" :key="url" class="ar-detail__picture"><img v-if="imageSources[url]" :src="imageSources[url]" :alt="`说说图片 ${index + 1}`" loading="lazy" decoding="async" @error="handleArchiveImageError(url)" /><button v-else class="ar-btn" type="button" :disabled="imageLoading[url]" @click="loadArchiveImage(url, detailItem.id, index)">{{ imageLoading[url] ? '正在读取图片…' : `加载第 ${index + 1} 张图片` }}</button></div>
        <h3>评论与回复 · {{ detailItem.comments.length }}</h3>
        <p v-if="!detailItem.comments.length">这条说说没有保留下来的评论。</p>
        <article v-for="(comment, index) in detailItem.comments" :key="index" class="ar-detail__comment"><strong>{{ comment.nickname || comment.uin || 'QQ 用户' }}</strong><time>{{ formatTime(comment.createdAt) }}</time><p class="selectable"><QzoneText :value="comment.content" /></p><div v-for="(reply, replyIndex) in comment.replies" :key="replyIndex" class="ar-detail__reply"><strong>{{ reply.nickname || reply.uin || 'QQ 用户' }}</strong> 回复 {{ reply.replyToNickname || reply.replyToUin || comment.nickname || 'QQ 用户' }}<p class="selectable"><QzoneText :value="reply.content" /></p></div></article>
      </div>
    </Drawer>
    <Dialog v-model:visible="confirmVisible" modal :closable="!deleting" :close-on-escape="!deleting" :draggable="false" class="ar-dialog" :header="confirmTitle">
      <div class="ar-dialog-body">
        <span class="ar-dialog-icon"><Trash2 :size="18" :stroke-width="1.8" /></span>
        <div>
          <p>{{ confirmDescription }}</p>
        </div>
      </div>
      <p v-if="error" class="ar-errorbar" role="alert">{{ describeError(error, '删除失败，请重试。') }}</p>
      <template #footer>
        <div class="ar-dialog-actions">
          <button type="button" class="ar-btn" :disabled="deleting" @click="confirmVisible = false">取消</button>
          <button type="button" class="ar-btn is-danger is-solid" :disabled="!canDelete" @click="confirmDelete">
            <LoaderCircle v-if="deleting" class="is-spinning" :size="16" :stroke-width="1.8" />
            <Trash2 v-else :size="16" :stroke-width="1.8" />
            <span>{{ deleting ? "正在删除…" : "确认删除" }}</span>
          </button>
        </div>
      </template>
    </Dialog>

    <!-- -------------------------------------------------------------- 灯箱 -->
    <ImageViewer v-if="imagePreviewVisible" :src="previewImageUrl" :name="previewImageName" title="说说照片" :index="previewIndex" :total="previewSources.length" @close="closeImagePreview" @step="stepImagePreview" @saved="toast.success('图片已保存')" @error="toast.error($event)" />
  </div>
</template>

<style scoped>
/* 根容器只负责纵向节奏；页面标题由 AppShell 顶栏承担。 */
.archive-page {
  --ar-control-h: 32px;
  --ar-rail-width: 68px;
  --ar-entry-gap: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

/* ------------------------------------------------------------------ 工具条 */

.ar-toolbar {
  min-width: 0;
}

.ar-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  min-width: 0;
}

.ar-row--meta {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--line-width) solid var(--color-border);
}

.ar-segments {
  display: inline-flex;
  flex-shrink: 0;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--color-surface-sunken);
  border-radius: var(--radius-md);
}

.ar-segment {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: calc(var(--ar-control-h) - var(--space-2));
  padding: 0 var(--space-3);
  border: var(--line-width) solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.ar-segment:hover {
  color: var(--color-text);
}

.ar-segment.is-active {
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.ar-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 200px;
  min-width: 0;
  max-width: 360px;
  height: var(--ar-control-h);
  padding: 0 var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
  transition: border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.ar-search:focus-within {
  border-color: var(--color-accent);
  background: var(--color-surface);
  box-shadow: var(--shadow-focus);
}

.ar-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--color-text);
}

.ar-search input::placeholder {
  color: var(--color-text-tertiary);
}

.ar-search input::-webkit-search-cancel-button {
  display: none;
}

.ar-search__clear {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-tertiary);
}

.ar-search__clear:hover {
  background: var(--color-border);
  color: var(--color-text);
}

.ar-filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.ar-filters :deep(.p-select) {
  display: inline-flex;
  align-items: center;
  height: var(--ar-control-h);
  min-width: 132px;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.ar-filters :deep(.p-select-label) {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text);
}

.ar-filters :deep(.p-select-dropdown) {
  width: var(--space-8);
}

.ar-quick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

/* --------------------------------------------------------------- 按钮基元 */

.ar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: var(--ar-control-h);
  padding: 0 var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.ar-btn:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  background: var(--color-surface-sunken);
  color: var(--color-text);
  text-decoration: none;
}

.ar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ar-btn.is-icon {
  width: var(--ar-control-h);
  padding: 0;
}

.ar-btn.is-ghost {
  border-color: transparent;
  background: transparent;
}

.ar-btn.is-primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-inverse);
}

.ar-btn.is-primary:hover:not(:disabled) {
  border-color: var(--color-accent-hover);
  background: var(--color-accent-hover);
  color: var(--color-text-inverse);
}

.ar-btn.is-danger {
  color: var(--color-danger);
}

.ar-btn.is-danger:hover:not(:disabled) {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.ar-btn.is-danger.is-solid {
  border-color: var(--color-danger);
  background: var(--color-danger);
  color: var(--color-text-inverse);
}

.ar-btn.is-danger.is-solid:hover:not(:disabled) {
  background: var(--color-danger);
  color: var(--color-text-inverse);
  filter: brightness(1.06);
}

.ar-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.ar-count {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.ar-count strong {
  color: var(--color-text);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.ar-bulk {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-left: auto;
  min-width: 0;
}

.ar-bulk__divider {
  width: 1px;
  height: 18px;
  background: var(--color-border);
}

.ar-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.ar-link:hover {
  text-decoration: underline;
}

.ar-link.is-strong {
  justify-content: flex-start;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
}

.ar-link__chevron {
  transition: transform var(--duration-fast) var(--ease-out);
}

.ar-link.is-open .ar-link__chevron {
  transform: rotate(180deg);
}

/* ------------------------------------------------------------ 错误 / 提示 */

.ar-errorbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-danger);
  border-radius: var(--radius-lg);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-sm);
}

.ar-errorbar__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ar-details {
  padding: var(--space-3) var(--space-5) var(--space-4);
  border-top: var(--line-width) solid var(--color-border);
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.ar-details summary {
  cursor: pointer;
  color: var(--color-text-secondary);
}

.ar-details p {
  margin-top: var(--space-2);
  font-family: var(--font-mono);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

/* ------------------------------------------------------------------ 时间轴 */

.ar-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--ar-entry-gap);
  min-width: 0;
}

.ar-year {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}

.ar-year::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--color-warm-border);
}

.ar-rail {
  position: relative;
  min-width: 0;
}

.ar-rail::before {
  content: "";
  position: absolute;
  top: 0;
  right: calc(-1 * var(--space-2));
  width: 1px;
  height: calc(100% + var(--ar-entry-gap));
  background: var(--color-warm-border);
}

.ar-entry:last-child .ar-rail::before {
  height: 100%;
}

.ar-node {
  position: absolute;
  top: calc(var(--space-5) + var(--space-3));
  right: calc(-1 * var(--space-2));
  width: 13px;
  height: 13px;
  border: 3px solid var(--color-canvas);
  border-radius: var(--radius-full);
  background: var(--color-warm);
  transform: translate(50%, -50%);
}

.ar-stamp {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
  padding-top: var(--space-5);
  text-align: right;
}

.ar-stamp strong {
  color: var(--color-warm);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.ar-stamp em {
  color: var(--color-text-tertiary);
  font-size: var(--text-2xs);
  font-style: normal;
  font-variant-numeric: tabular-nums;
}

/* -------------------------------------------------------------- 说说卡片 */

.ar-card {
  min-width: 0;
  padding: var(--density-card-padding, var(--space-5));
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}

.ar-card:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-sm);
}

.ar-card.is-selected {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
}

.ar-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.ar-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.ar-avatar.is-small {
  width: 26px;
  height: 26px;
}

.ar-avatar.is-tiny {
  width: 22px;
  height: 22px;
}

.ar-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ar-publisher {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}

.ar-publisher strong {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ar-publisher > span {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
  font-size: var(--text-2xs);
}

.ar-content {
  margin-top: var(--space-3);
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ar-card :deep(.p-checkbox) {
  flex-shrink: 0;
}

/* -------------------------------------------------------------- 图片网格 */

.ar-pictures {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
  min-width: 0;
}

.ar-pictures.is-1 {
  grid-template-columns: minmax(0, 260px);
}

.ar-pictures.is-2 {
  grid-template-columns: repeat(2, minmax(0, 190px));
}

.ar-pictures.is-1 .ar-picture,
.ar-pictures.is-1 .ar-picture-pending {
  aspect-ratio: 4 / 3;
}

.ar-picture,
.ar-picture-pending {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.ar-picture {
  padding: 0;
  cursor: zoom-in;
}

.ar-picture img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--duration-base) var(--ease-out);
}

.ar-picture:hover img {
  transform: scale(1.03);
}

.ar-picture-pending {
  gap: var(--space-1);
  font-size: var(--text-2xs);
  text-align: center;
}

.ar-retry {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-2xs);
}

.ar-retry:hover {
  text-decoration: underline;
}

.ar-picture-more {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-overlay);
  color: var(--color-text-inverse);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  pointer-events: none;
}

/* ------------------------------------------------------------------ 视频 */

.ar-video {
  display: block;
  width: 100%;
  max-height: 360px;
  margin-top: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.ar-video-cover {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 180px;
  max-height: 320px;
  margin-top: var(--space-3);
  overflow: hidden;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  cursor: pointer;
}

.ar-video-cover > img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ar-video-cover.is-loading {
  cursor: wait;
}

.ar-video-shade {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--color-overlay);
  color: var(--color-text-inverse);
  text-align: center;
  font-size: var(--text-xs);
}

.ar-video-play {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-full);
  background: var(--color-overlay);
  color: var(--color-text-inverse);
}

.ar-video-shade strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.ar-video-shade small {
  color: var(--color-text-inverse);
  opacity: 0.72;
  font-size: var(--text-2xs);
}

/* ------------------------------------------------------------ 互动与评论 */

.ar-assets {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: var(--line-width) solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.ar-assets > span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.ar-assets svg {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.ar-likes {
  flex-wrap: wrap;
  line-height: var(--leading-normal);
}

.ar-like-names {
  color: var(--color-text);
}

.ar-like-person {
  color: var(--color-text);
  text-decoration: underline dotted var(--color-border-strong);
  text-underline-offset: 3px;
  cursor: help;
}

.ar-like-person.is-historical {
  text-decoration-color: var(--color-warm-border);
}

.ar-like-note {
  flex-basis: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-warm-soft);
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
}

.ar-comments {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.ar-comment,
.ar-reply {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}

.ar-comment-body {
  flex: 1;
  min-width: 0;
}

.ar-comment-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  color: var(--color-text-tertiary);
  font-size: var(--text-2xs);
}

.ar-comment-meta strong {
  color: var(--color-accent);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.ar-comment-body p {
  margin-top: var(--space-1);
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ar-replies {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-left: var(--space-3);
  border-left: var(--line-width) solid var(--color-warm-border);
}

/* ---------------------------------------------------------------- 骨架屏 */

.ar-card.is-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ar-skeleton-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.ar-skeleton-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
}

.ar-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: var(--space-2);
}

/* ------------------------------------------------------- 加载更多 / 收尾 */

.ar-sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.ar-end {
  padding: var(--space-4);
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  text-align: center;
}

.is-spinning {
  animation: ar-spin 1s linear infinite;
}

@keyframes ar-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------------------------------------------------------------- 删除框 */

/* Dialog 会把内容 teleport 到 body，用 :global 保证宽度约束稳定生效。 */
:global(.ar-dialog) {
  width: min(420px, calc(100vw - var(--space-8)));
}

.ar-dialog-body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.ar-dialog-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.ar-dialog-body p {
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.ar-dialog-body small {
  display: block;
  margin-top: var(--space-2);
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.ar-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* ------------------------------------------------------------------ 灯箱 */

/* -------------------------------------------------------------- 响应式 */

@media (max-width: 1080px) {
  .archive-page {
    --ar-rail-width: 60px;
    --ar-entry-gap: var(--space-4);
  }

  .ar-row {
    gap: var(--space-2);
  }

  .ar-filters :deep(.p-select) {
    min-width: 116px;
  }
}

@media (max-width: 860px) {
  .archive-page {
    --ar-rail-width: 52px;
  }

  .ar-stamp em {
    display: none;
  }

  .ar-segment span {
    display: none;
  }

  .ar-segment {
    padding: 0 var(--space-2);
  }

  .ar-search {
    max-width: none;
  }

  .ar-filters {
    flex: 1 1 100%;
  }

  .ar-filters :deep(.p-select) {
    flex: 1;
    min-width: 0;
  }

  .ar-bulk {
    width: 100%;
    margin-left: 0;
  }

  .ar-bulk__divider {
    display: none;
  }

  .ar-card {
    padding: var(--space-4);
  }

  .ar-pictures {
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  }

  .ar-pictures.is-2 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.ar-view-tools { display:flex; justify-content:space-between; flex-wrap:wrap; gap:var(--space-3); margin-top:var(--space-4); }
.ar-view-tools [aria-pressed="true"] { background:var(--color-surface); color:var(--color-accent); border-color:var(--color-accent-border); }
.ar-refinements { padding:var(--space-4); margin-top:var(--space-3); background:var(--color-canvas); border-radius:var(--radius-md); }
.ar-refinements > p { color:var(--color-text-secondary); font-size:var(--text-xs); margin-bottom:var(--space-3); }
.ar-refinements__fields { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-4); }
.ar-refinements__fields label { display:flex; align-items:center; gap:var(--space-2); font-size:var(--text-xs); }
.ar-refinements input[type="date"] { min-height:var(--control-height); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); padding:var(--space-2); background:var(--color-surface); color:var(--color-text); min-width:0; }
.ar-refinements input[type="checkbox"] { accent-color:var(--color-accent); }
.ar-record-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:var(--space-4); margin-bottom:var(--space-4); }
.ar-timeline.is-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-5); }
.ar-timeline.is-cards .ar-entry { display:block; padding:0; }
.ar-timeline.is-cards .ar-entry::before,.ar-timeline.is-cards .ar-rail,.ar-timeline.is-cards .ar-year { display:none; }
.ar-timeline.is-cards .ar-card { height:100%; }
.ar-detail { display:flex; flex-direction:column; gap:var(--space-5); }
.ar-detail__date,.ar-detail time { color:var(--color-text-secondary); font-size:var(--text-xs); }
.ar-detail__text { line-height:var(--leading-relaxed); white-space:pre-wrap; overflow-wrap:anywhere; }
.ar-detail__picture img { width:100%; object-fit:contain; border-radius:var(--radius-md); }
.ar-detail__comment { padding:var(--space-4); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); }
.ar-detail__comment > time { display:block; margin-bottom:var(--space-3); }
.ar-detail__comment p { white-space:pre-wrap; overflow-wrap:anywhere; }
.ar-detail__reply { margin-top:var(--space-3); padding:var(--space-3); background:var(--color-surface-sunken); border-left:var(--focus-width) solid var(--color-accent-border); border-radius:var(--radius-sm); }
.ar-entry {
  display: grid;
  grid-template-columns: var(--ar-rail-width) minmax(0, 1fr);
  column-gap: var(--space-4);
  min-width: 0; content-visibility:auto; contain-intrinsic-size:auto 480px; }
@media (max-width:1080px) { .ar-timeline.is-cards { grid-template-columns:minmax(0,1fr); } }
@media (max-width:860px) { .ar-btn,.ar-segment { min-height:var(--touch-target); } .ar-refinements__fields { gap:var(--space-3); } .ar-refinements__fields label { min-height:var(--touch-target); flex-wrap:wrap; } }


/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .archive-page { gap:var(--layout-page-gap); }
.ar-toolbar { position:sticky; top:0; z-index:var(--z-toolbar); box-shadow:var(--shadow-xs); }
.ar-row { gap:var(--space-3); }
.ar-card { box-shadow:none; border-radius:var(--radius-lg); }
.ar-card:hover { border-color:var(--color-border-strong); }
.ar-stamp { font-variant-numeric:tabular-nums; font-size:var(--text-xs); }
.ar-entry { margin-bottom:var(--space-4); }
.ar-segment,.ar-btn { min-height:var(--control-height); }
.ar-search { background:var(--color-surface); }
.ar-bulk { background:var(--color-accent-soft); border-radius:var(--radius-md); padding:var(--space-2) var(--space-3); }
@media(max-width:600px) { .ar-toolbar { position:static; } .ar-row { gap:var(--space-2); } .ar-btn,.ar-segment { min-height:var(--touch-target); } }

/* On phones, the real year remains the timeline anchor; content uses the full width. */
.ar-extra-tools { display:contents; }
.ar-mobile-tools { display:none; }
.ar-category-short { display:none; }
@media(max-width:860px) {
 .archive-page { --ar-rail-width:0px; }
 .ar-toolbar :deep(.qza-card__body) { padding:var(--space-3); }
 .ar-toolbar > :deep(.qza-card__body) > .ar-row:first-child { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-2); }
 .ar-segments { padding:0; }
 .ar-segment { min-width:var(--touch-target); gap:var(--space-1); }
 .ar-segment .ar-category-short { display:inline; }
 .ar-search { height:var(--touch-target); grid-column:1 / -1; grid-row:1; }
 .ar-search input { min-height:var(--touch-target); }
 .ar-search__clear { width:var(--touch-target); height:var(--touch-target); margin-right:calc(-1 * var(--space-3)); }
 .ar-toolbar > :deep(.qza-card__body) > .ar-row:first-child > .ar-segments { grid-column:1; grid-row:2; justify-self:start; }
 .ar-filters { grid-column:1 / -1; grid-row:3; }
 .ar-filters :deep(.p-select) { min-height:var(--touch-target); }
 .ar-quick { grid-column:2; grid-row:2; }
 .ar-quick .is-icon { width:var(--touch-target); min-height:var(--touch-target); }
 .ar-row--meta { justify-content:space-between; gap:var(--space-2); margin-top:var(--space-2); padding-top:var(--space-2); }
 .ar-count { flex:1; }
 .ar-count__category { display:none; }
 .ar-mobile-tools { display:inline-flex; min-height:var(--touch-target); }
 .ar-mobile-tools[aria-expanded="true"] > svg:last-child { transform:rotate(180deg); }
 .ar-extra-tools { display:none; }
 .ar-extra-tools.is-open { display:block; }
 .ar-entry { display:block; }
 .ar-rail { display:none; }
 .ar-year { margin:var(--space-4) 0 var(--space-3); letter-spacing:normal; }
 .ar-card { padding:var(--space-4); }
 .ar-head { gap:var(--space-2); }
 .ar-avatar { width:var(--space-8); height:var(--space-8); }
 .ar-publisher strong { font-size:var(--text-base); }
 .ar-publisher > span { font-size:var(--text-xs); }
 .ar-publisher__uin { display:none; }
 .ar-card :deep(.p-checkbox) { width:var(--touch-target); height:var(--touch-target); display:grid; place-items:center; }
 .ar-content { font-size:var(--text-md); margin-top:var(--space-3); }
 .ar-record-actions { justify-content:flex-start; gap:var(--space-4); margin-block:var(--space-2); }
 .ar-link,.ar-retry { min-height:var(--touch-target); display:inline-flex; align-items:center; }
 .ar-pictures.is-1,.ar-pictures.is-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
 .ar-pictures.is-1 { grid-template-columns:minmax(0,1fr); }
 .ar-picture-pending { align-content:center; gap:var(--space-2); }
 .ar-comment-meta { gap:var(--space-1) var(--space-2); }
 .ar-comment-meta > span { display:none; }
 .ar-comment-meta time { flex-basis:100%; }
 .ar-comments { padding:var(--space-3); }
 .ar-bulk { padding:var(--space-2); background:var(--color-surface-sunken); }
 .ar-bulk .ar-btn { flex:1 1 auto; }
 .ar-view-tools { gap:var(--space-2); }
 .ar-toolbar { position:static; }
}
</style>
