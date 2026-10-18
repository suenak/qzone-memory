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
import { useArchiveStore } from "../stores/archive";
import { useLicenseStore } from "../stores/license";
import { useToast } from "../composables/useToast";
import { syncCookiesToWebview } from "../utils/qlogin";
import { checkRecyclePassword, closeRecyclePasswordWindow, createQzoneAlbum, listQzoneAlbums, listRecycleAlbums, listRecyclePhotos, loadRecyclePhotoPreview, openRecyclePasswordWindow, prepareRecyclePasswordWindow, recoverRecycleAlbum, recoverRecyclePhotos } from "../utils/qzone";

interface Album { id: string; name: string; count: number }
interface Photo { id: string; sourceAlbumId: string; name: string; url?: string; deletedAt?: string }
const auth = useAuthStore();
const recycleSession = useRecycleSessionStore();
const archive = useArchiveStore();
const license = useLicenseStore();
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
const recoveryPhotos = ref<Photo[]>([]);
const previewPendingIds = ref(new Set<string>());
let verifyRun = 0;
let photoSequence = 0;
let destinationSequence = 0;
let recoverySequence = 0;
let disposed = false;
let waitingForInitialLoad = false;
const delays = new Set<() => void>();
const verified = computed(() => auth.loggedIn && Boolean(auth.user?.uin) && Boolean(token.value) && ownerUin.value === auth.user?.uin);
const recoveryBusy = computed(() => recovering.value || albumRecovering.value || archive.busy);
const canRecover = computed(() => verified.value && license.canArchive && !recoveryBusy.value && !auth.loading && !auth.dialogVisible);
const allSelected = computed(() => photos.value.length > 0 && selectedIds.value.length === photos.value.length);
const activeAlbum = computed(() => albums.value.find((item) => item.id === activeAlbumId.value));
function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); delays.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms);
    delays.add(finish);
  });
}
function cancelDelays() { for (const finish of [...delays]) finish(); }
function session() { return { uin: auth.user?.uin, signature: token.value }; }
function currentSession(source: ReturnType<typeof session>) {
  return !disposed && verified.value && source.uin === auth.user?.uin && source.signature === token.value;
}
function closeVerificationWindow() {
  return recycleSession.withVerificationWindow(async () => {
    if (isTauri()) await closeRecyclePasswordWindow();
  }).catch(() => {});
}
function stopVerification() {
  verifyRun += 1;
  verifying.value = false;
  cancelDelays();
  void closeVerificationWindow();
}
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
  if (disposed || !verified.value || recoveryBusy.value) return;
  closeRecoverDialog();
  albumRecoverTarget.value = null;
  await fetchPhotos(albumId);
}
async function fetchPhotos(albumId = "") {
  if (disposed || !verified.value) return;
  const source = session();
  const sequence = ++photoSequence;
  // 预览失败标记与新的一批照片一一对应：不重置的话，「刷新」后会有一批卡片
  // 永远走失败回退分支，刷新对它们永久失效。
  loading.value = true; error.value = ""; selectedIds.value = []; resetSelectedSets();
  photos.value = [];
  previewPendingIds.value = new Set();
  activeAlbumId.value = albumId;
  try {
    const mapped = mapPhotos(await listRecyclePhotos(source.signature, albumId || undefined), albumId);
    if (sequence !== photoSequence || !currentSession(source)) return;
    previewPendingIds.value = new Set(mapped.filter((photo) => photo.url && !photo.url.startsWith("data:")).map((photo) => photo.id));
    photos.value = mapped.map((photo) => ({ ...photo, url: photo.url?.startsWith("data:") ? photo.url : undefined }));
    const previews = await Promise.all(mapped.map(async (photo) => {
      if (!photo.url || photo.url.startsWith("data:")) return photo;
      try { return { ...photo, url: await loadRecyclePhotoPreview(photo.url) }; }
      // 取回失败时把地址置空，而不是留下原始 http 地址：那个地址是后端刻意
      // 拒绝加载的非 QQ 域名，交给 <img> 只会得到一个永不消失的骨架。
      catch { return { ...photo, url: undefined }; }
    }));
    if (sequence === photoSequence && currentSession(source)) photos.value = previews;
  }
  catch (reason) { if (sequence === photoSequence && currentSession(source)) error.value = String(reason); }
  finally { if (!disposed && sequence === photoSequence) { loading.value = false; previewPendingIds.value = new Set(); } }
}
async function loadAll() {
  if (disposed || !verified.value || recoveryBusy.value) return;
  closeRecoverDialog();
  albumRecoverTarget.value = null;
  await fetchAll();
}
async function fetchAll() {
  if (disposed || !verified.value) return;
  const source = session();
  // 与 loadPhotos 共用序号：并发点两次「刷新」时，先发的响应不再覆盖后发的结果。
  const sequence = ++photoSequence;
  loading.value = true; error.value = ""; resetSelectedSets();
  photos.value = []; albums.value = []; selectedIds.value = []; activeAlbumId.value = "";
  try {
    const mapped = mapAlbums(await listRecycleAlbums(source.signature));
    if (sequence !== photoSequence || !currentSession(source)) return;
    albums.value = mapped;
    await fetchPhotos();
  }
  catch (reason) { if (sequence === photoSequence && currentSession(source)) error.value = String(reason); }
  finally { if (!disposed && sequence === photoSequence) loading.value = false; }
}
async function verify() {
  if (disposed || verifying.value || recoveryBusy.value) return;
  if (!auth.loggedIn) { await auth.openLogin(); return; }
  if (!license.canArchive) { error.value = "更新软件授权后可验证回收站。已有的本地记录仍可查看。"; return; }
  const uin = auth.user?.uin;
  if (!uin) return;
  const run = ++verifyRun; verifying.value = true; error.value = "";
  const current = () => !disposed && run === verifyRun && verifying.value && auth.loggedIn && auth.user?.uin === uin;
  try {
    await recycleSession.withVerificationWindow(async () => {
      if (!current()) return;
      if (platform() === "macos") {
        // Creating this legacy QQ page from a Rust async command has caused
        // WKWebView process aborts on macOS. Let Tauri's JS window manager own
        // the window and keep the page free of injected scripts instead.
        const url = await prepareRecyclePasswordWindow();
        if (!current()) return;
        await syncCookiesToWebview();
        if (!current()) return;
        const existing = await WebviewWindow.getByLabel("qzone-recycle-auth");
        if (!current()) return;
        if (existing) await existing.close();
        if (!current()) return;
        const verificationWindow = new WebviewWindow("qzone-recycle-auth", {
          url, title: "验证 QQ 空间独立密码", width: 960, height: 720,
          minWidth: 560, minHeight: 520, center: true, focus: true,
        });
        await new Promise<void>((resolve, reject) => {
          void verificationWindow.once("tauri://created", () => resolve()).catch(reject);
          void verificationWindow.once("tauri://error", (event) => reject(new Error(String(event.payload)))).catch(reject);
        });
      } else {
        await openRecyclePasswordWindow();
      }
    });
    while (current()) {
      const result = await checkRecyclePassword();
      if (!current()) return;
      if (result) {
        verifying.value = false;
        recycleSession.setVerified(result, uin);
        /* 收尾各自兜错：签名已经写入，关窗或加载失败都只是收尾问题，
         * 抛到同一个 catch 会得到「已验证 + 列表空白 + 错误提示」的矛盾界面。 */
        await closeVerificationWindow();
        if (!disposed && auth.user?.uin === uin && token.value === result && ownerUin.value === uin) await loadAll();
        return;
      }
      await delay(1200);
    }
  } catch (reason) { if (current()) { error.value = String(reason); void closeVerificationWindow(); } }
  finally { if (!disposed && run === verifyRun) verifying.value = false; }
}
/* 原来的全选逻辑合并进 toggleVisibleSelection（同一份 photos 列表），
 * 只作用域到当前列表，避免与「已选 N 张」的显示不一致。 */
async function openRecoverDialog() {
  if (disposed || !canRecover.value || loading.value || activeAlbumId.value) return;
  const selected = new Set(selectedIds.value);
  recoveryPhotos.value = photos.value.filter((photo) => selected.has(photo.id)).map((photo) => ({ ...photo }));
  if (!recoveryPhotos.value.length) return;
  recoveredCount.value = 0;
  recoverConfirmed.value = false;
  destinationAlbums.value = [];
  destinationAlbumId.value = "";
  destinationMode.value = "existing";
  recoveryAlbumName.value = "恢复相册";
  destinationError.value = "";
  confirmVisible.value = true;
  await selectDestinationMode("existing");
}
async function selectDestinationMode(mode: "create" | "existing") {
  if (disposed || !verified.value || !confirmVisible.value || recovering.value) return;
  const source = session();
  const sequence = ++destinationSequence;
  destinationMode.value = mode;
  destinationLoading.value = false;
  destinationError.value = "";
  if (mode !== "existing" || destinationAlbums.value.length) return;
  destinationLoading.value = true;
  try {
    const result = await listQzoneAlbums();
    if (sequence !== destinationSequence || !currentSession(source) || !confirmVisible.value || destinationMode.value !== "existing") return;
    destinationAlbums.value = mapAlbums(result);
    destinationAlbumId.value = destinationAlbums.value[0]?.id ?? "";
  } catch (reason) {
    if (sequence !== destinationSequence || !currentSession(source) || !confirmVisible.value) return;
    destinationAlbums.value = [];
    destinationAlbumId.value = "";
    destinationError.value = `已有相册加载失败：${String(reason)}`;
  } finally {
    if (!disposed && sequence === destinationSequence) destinationLoading.value = false;
  }
}
async function recover() {
  if (disposed || !confirmVisible.value || !recoverConfirmed.value || !canRecover.value || destinationLoading.value || !recoveryPhotos.value.length) return;
  const source = session();
  const sequence = ++recoverySequence;
  const current = () => sequence === recoverySequence && currentSession(source) && confirmVisible.value;
  const mode = destinationMode.value;
  const name = recoveryAlbumName.value.trim();
  let targetAlbumId = destinationAlbumId.value;
  if (mode === "create" ? !name : !destinationAlbums.value.some((album) => album.id === targetAlbumId)) {
    error.value = mode === "create" ? "请输入新相册名称" : "请选择恢复目标相册";
    return;
  }
  const groups = new Map<string, string[]>();
  for (const photo of recoveryPhotos.value) {
    if (!photo.sourceAlbumId) { error.value = "照片缺少回收站来源相册 ID"; return; }
    const group = groups.get(photo.sourceAlbumId) ?? [];
    if (!group.includes(photo.id)) group.push(photo.id);
    groups.set(photo.sourceAlbumId, group);
  }
  recovering.value = true; error.value = ""; recoveredCount.value = 0;
  try {
    await archive.withRecycleRecovery(async () => {
      if (!current()) return;
      if (mode === "create") {
        const beforeAlbums = mapAlbums(await listQzoneAlbums());
        if (!current()) return;
        // 重试复用同名相册，避免把剩余照片分散到第二个新建相册。
        const existing = beforeAlbums.find((album) => album.name === name);
        targetAlbumId = existing?.id ?? "";
        if (!targetAlbumId) {
          const previousIds = new Set(beforeAlbums.map((album) => album.id));
          const created = await createQzoneAlbum(name);
          if (!current()) return;
          for (let attempt = 0; attempt < 3 && !targetAlbumId; attempt += 1) {
            const refreshed = mapAlbums(await listQzoneAlbums());
            if (!current()) return;
            targetAlbumId = refreshed.find((album) => album.name === name && !previousIds.has(album.id))?.id ?? "";
            if (!targetAlbumId && attempt < 2) { await delay(300 * (attempt + 1)); if (!current()) return; }
          }
          targetAlbumId ||= responseAlbumId(created);
          if (!targetAlbumId) throw new Error("相册已创建，但响应中缺少相册 ID，请刷新后重试");
          // 新相册会先出现在列表服务中，照片恢复服务通常还需要短暂同步。
          await delay(1800);
          if (!current()) return;
        }
      }
      // 逐组串行恢复，成功的分组立刻从待办剔除。
      for (const [sourceAlbumId, ids] of groups) {
        if (!current()) return;
        await recoverRecyclePhotos(source.signature, sourceAlbumId, targetAlbumId, ids);
        if (!current()) return;
        recoveredCount.value += ids.length;
        const succeeded = new Set(ids);
        // Persist completed groups in the page's actual retry state. A local Map
        // alone is recreated on retry and would submit those photos again.
        recoveryPhotos.value = recoveryPhotos.value.filter((photo) => !succeeded.has(photo.id));
        selectedIds.value = selectedIds.value.filter((id) => !succeeded.has(id));
        photos.value = photos.value.filter((photo) => !succeeded.has(photo.id));
      }
      confirmVisible.value = false;
      toast.success("照片已提交恢复，可从回收站列表确认结果。");
      await fetchPhotos(activeAlbumId.value);
    });
  }
  catch (reason) {
    if (!current()) return;
    // 部分成功时把已恢复数量说清楚，用户才知道剩下几张还需要重试。
    error.value = recoveredCount.value
      ? `本次已成功恢复 ${recoveredCount.value} 张照片，其余照片未恢复：${String(reason)}`
      : String(reason);
  }
  finally { if (!disposed) recovering.value = false; }
}
function openAlbumRecoverDialog(album: Album) {
  if (disposed || !canRecover.value || loading.value || !albums.value.some((item) => item.id === album.id)) return;
  albumRecoverTarget.value = { ...album };
}
async function recoverAlbum() {
  if (disposed || !albumRecoverTarget.value || !canRecover.value) return;
  const source = session();
  const target = { ...albumRecoverTarget.value };
  const sequence = ++recoverySequence;
  const current = () => sequence === recoverySequence && currentSession(source) && albumRecoverTarget.value?.id === target.id;
  albumRecovering.value = true; error.value = "";
  try {
    await archive.withRecycleRecovery(async () => {
      if (!current()) return;
      await recoverRecycleAlbum(source.signature, target.id);
      if (!current()) return;
      albumRecoverTarget.value = null;
      toast.success("整个相册已恢复，可从回收站列表确认结果。");
      await fetchAll();
    });
  } catch (reason) { if (current()) error.value = String(reason); }
  finally { if (!disposed) albumRecovering.value = false; }
}
function resetVerification() {
  if (disposed || recoveryBusy.value) return;
  // 先让在飞的验证轮询失效并停止，再清前端会话；否则旧会话清空后，
  // 仍在跑的轮询可能把刚验证到的签名重新写回去。
  stopVerification();
  recycleSession.clear();
  // 后端仍持有旧签名；关闭验证窗口后，下一次「验证独立密码」会开新窗口并清掉它。
}
function clearSessionView() {
  waitingForInitialLoad = false;
  photoSequence += 1; destinationSequence += 1; recoverySequence += 1;
  cancelDelays();
  loading.value = false; destinationLoading.value = false;
  photos.value = []; albums.value = []; selectedIds.value = []; recoveryPhotos.value = [];
  activeAlbumId.value = ""; previewPendingIds.value = new Set();
  confirmVisible.value = false; recoverConfirmed.value = false; albumRecoverTarget.value = null;
  destinationAlbums.value = []; destinationAlbumId.value = ""; destinationError.value = "";
  error.value = ""; recoveredCount.value = 0;
  resetSelectedSets();
}
watch([token, ownerUin], clearSessionView, { flush: "sync" });
watch(() => auth.user?.uin ?? "", () => {
  stopVerification();
  recycleSession.clear();
  clearSessionView();
}, { flush: "sync" });
function resumeInitialLoad() {
  if (!waitingForInitialLoad || disposed || !verified.value || archive.busy) return;
  waitingForInitialLoad = false;
  void loadAll();
}
watch([verified, () => archive.busy], resumeInitialLoad);
onMounted(() => {
  if (token.value && ownerUin.value === auth.user?.uin) {
    waitingForInitialLoad = true;
    loading.value = true;
    resumeInitialLoad();
  }
  else if (token.value) recycleSession.clear();
});
onBeforeUnmount(() => {
  disposed = true;
  stopVerification();
  photoSequence += 1; destinationSequence += 1; recoverySequence += 1;
});

/* ---------------------------------------------------------------------- UI 层
 * 以下全部是展示用状态，不触碰上面的业务逻辑：
 * 步骤指示、已加载标记、预览可见性、图片加载失败标记、危险操作二次确认。 */

/** 预览失败标记与可见集合一起复位；由 loadPhotos / loadAll / resetVerification 调用。 */
function resetSelectedSets() {
  failedPreviewIds.value = new Set();
  visiblePhotoIds.value = new Set();
  observer?.disconnect();
  observedCards = new WeakSet<Element>();
}

const toast = useToast();
const visiblePhotoIds = ref(new Set<string>());
const failedPreviewIds = ref(new Set<string>());
const recoverConfirmed = ref(false);
/** 本次恢复流程里已经成功的照片数：部分失败时用它给出「已成功恢复 N 张」。 */
const recoveredCount = ref(0);
let observer: IntersectionObserver | undefined;
/** 已经交给观察器的卡片，补观察时用它去重，避免重复 observe 与全量重查。 */
let observedCards = new WeakSet<Element>();
const photoGrid = ref<HTMLElement | null>(null);

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
  // A missing/failed URL is terminal; only an actual pending request shows a skeleton.
  return previewPendingIds.value.has(photo.id);
}

function photoFailed(photo: Photo) {
  return failedPreviewIds.value.has(photo.id);
}

function markPreviewFailed(photo: Photo) {
  if (disposed || !photos.value.some((item) => item.id === photo.id)) return;
  failedPreviewIds.value = new Set(failedPreviewIds.value).add(photo.id);
}

/** 观察器实例：懒建一次后长期复用，不再每次重绘都 disconnect + 新建。 */
function ensureObserver() {
  if (disposed || observer || typeof IntersectionObserver === "undefined") return observer;
  observer = new IntersectionObserver((entries) => {
    if (disposed) return;
    const next = new Set(visiblePhotoIds.value);
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (!photoGrid.value?.contains(entry.target)) continue;
      const id = (entry.target as HTMLElement).dataset.photoId;
      if (id) next.add(id);
    }
    /* 集合内容没变就不赋值：这个 Set 参与渲染求值，每次新实例都会触发重渲染，
     * 而 onUpdated 又会补观察卡片 → 形成无限循环。 */
    if (next.size === visiblePhotoIds.value.size && [...next].every((id) => visiblePhotoIds.value.has(id))) return;
    visiblePhotoIds.value = next;
  }, { rootMargin: "240px 0px" });
  return observer;
}

/** 观察器只建一次，这里只把「新出现的」卡片补进去，不再做全量 DOM 查询。 */
function observeCards() {
  if (disposed || !photoGrid.value) return;
  const current = ensureObserver();
  if (!current) return;
  photoGrid.value.querySelectorAll<HTMLElement>("[data-photo-id]").forEach((element) => {
    if (observedCards.has(element)) return;
    observedCards.add(element);
    current.observe(element);
  });
}

function toggleVisibleSelection() {
  if (disposed || recoveryBusy.value || confirmVisible.value || loading.value) return;
  const visible = new Set(visiblePhotoIds$.value);
  selectedIds.value = allSelected.value
    ? selectedIds.value.filter((id) => !visible.has(id))
    : [...new Set([...selectedIds.value, ...visible])];
}

async function confirmWithRecover() {
  if (disposed || !confirmVisible.value || !recoverConfirmed.value || !canRecover.value) return;
  // 重试前清掉上一次的失败说明，避免旧的「已成功恢复 N 张」残留在弹窗里。
  error.value = "";
  await recover();
}

async function openRecoverDialogGuarded() {
  if (disposed || !canRecover.value || loading.value) return;
  error.value = "";
  recoverConfirmed.value = false;
  await openRecoverDialog();
}

function closeRecoverDialog() {
  if (disposed || recovering.value) return;
  destinationSequence += 1;
  destinationLoading.value = false;
  confirmVisible.value = false;
  recoverConfirmed.value = false;
  recoveryPhotos.value = [];
}

/** 弹窗真正收起后清理确认状态；成功提示由恢复命令的确认响应触发。 */
function onRecoverDialogHide() {
  if (disposed || confirmVisible.value) return;
  destinationSequence += 1;
  destinationLoading.value = false;
  recoverConfirmed.value = false;
  recoveryPhotos.value = [];
}

function openAlbumRecoverDialogGuarded(album: Album) {
  if (disposed || !canRecover.value || loading.value) return;
  error.value = "";
  openAlbumRecoverDialog(album);
}

async function confirmAlbumRecover() {
  await recoverAlbum();
}

function closeAlbumDialog() {
  if (!disposed && !albumRecovering.value) albumRecoverTarget.value = null;
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
// 照片列表每次重绘后只补充观察新卡片（预览是逐张异步解析出来的），不再重建观察器。
onUpdated(() => { observeCards(); });
onBeforeUnmount(() => { observer?.disconnect(); observer = undefined; });
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
            :disabled="archive.busy || auth.loading || license.loading"
            @click="verify"
          ><template #icon><ShieldCheck :size="16" :stroke-width="1.8" /></template></Button>
          <Button v-if="verifying" label="停止等待" severity="secondary" text @click="stopVerification" ><template #icon><X :size="16" :stroke-width="1.8" /></template></Button>
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
          <Button label="重新验证" severity="secondary" text size="small" :disabled="recoveryBusy" @click="resetVerification" ><template #icon><KeyRound :size="16" :stroke-width="1.8" /></template></Button>
          <Button label="刷新" severity="secondary" text size="small" :loading="loading" :disabled="recoveryBusy" @click="loadAll" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
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
              :disabled="!canRecover || loading"
              @click="openAlbumRecoverDialogGuarded(activeAlbum)"
            ><template #icon><FolderOpen :size="16" :stroke-width="1.8" /></template></Button>
            <Button
              v-else
              :label="`恢复所选 (${selectedIds.length})`"

              :disabled="!selectedIds.length || !canRecover || loading"
              @click="openRecoverDialogGuarded"
            ><template #icon><RotateCcw :size="16" :stroke-width="1.8" /></template></Button>
          </div>
        </div>

        <div v-if="error" class="error-banner">
          <CircleAlert :size="16" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ friendlyError(error) }}</span>
            <Button label="刷新重试" size="small" severity="secondary" outlined :disabled="recoveryBusy" @click="loadAll" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
        </div>
        <!-- 后端固定只返回最近 18 张（size=18, dayNum=90），文案不能暗示「全部」。 -->
        <p v-if="!activeAlbum" class="list-note">当前显示最近 90 天内回收的前 18 张照片，勾选后可恢复到指定相册。</p>
      </SectionCard>

      <div class="recycle-layout">
        <!-- 回收站相册列表 -->
        <SectionCard flush class="album-panel">
          <nav class="album-list" aria-label="回收站相册">
            <button
              type="button"
              class="album-item"
              :disabled="recoveryBusy"
              :class="{ 'is-active': !activeAlbumId }"
              @click="loadPhotos()"
            >
              <span class="album-item__icon" aria-hidden="true"><Images :size="18" :stroke-width="1.8" /></span>
              <span class="album-item__copy">
                <!-- 后端 list_recycle_photos 固定取 size=18，这里不是「全部相册」的聚合。 -->
                <strong>全部照片</strong>
                <small>最近回收的 18 张</small>
              </span>
            </button>
            <button
              v-for="album in albums"
              :key="album.id"
              type="button"
              class="album-item"
              :disabled="recoveryBusy"
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
            <Button label="查看全部照片" severity="secondary" size="small" :disabled="recoveryBusy" @click="loadPhotos()" />
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
                <Button label="刷新" severity="secondary" outlined size="small" :loading="loading" :disabled="recoveryBusy" @click="loadAll" ><template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template></Button>
              </EmptyState>
            </template>

            <template v-else>
              <div v-if="!activeAlbum" class="select-row">
                <Checkbox
                  :model-value="allSelected"
                  binary
                  :disabled="recoveryBusy || confirmVisible"
                  input-id="select-all-recycle"
                  @update:model-value="toggleVisibleSelection"
                />
                <label for="select-all-recycle">全选当前照片（最多 {{ photos.length }} 张）</label>
                <span v-if="selectedIds.length" class="select-row__count">已选 {{ selectedIds.length }} 张</span>
              </div>

              <div ref="photoGrid" class="photo-grid">
                <label
                  v-for="photo in photos"
                  :key="photo.id"
                  class="photo-card"
                  :class="{ 'is-selected': selectedIds.includes(photo.id), 'is-selectable': !activeAlbum }"
                  :data-photo-id="photo.id"
                >
                  <span class="photo-card__media">
                    <!-- 只有已解析出的真实地址才交给 <img>；原始 http 地址由后端白名单拒绝，
                         渲染它只会得到一个永不消失的骨架。 -->
                    <img
                      v-if="photo.url && !photoFailed(photo)"
                      :src="photo.url"
                      :alt="photo.name"
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @error="markPreviewFailed(photo)"
                    />
                    <span v-else-if="photoPending(photo)" class="photo-card__placeholder">
                      <SkeletonBlock width="100%" height="100%" />
                    </span>
                    <span v-else class="photo-card__placeholder is-fallback">
                      <ImageOff :size="20" :stroke-width="1.8" aria-hidden="true" />
                      <small>预览不可用</small>
                    </span>
                  </span>

                  <span v-if="!activeAlbum" class="photo-card__check" aria-hidden="true">
                    <Checkbox v-model="selectedIds" :disabled="recoveryBusy || confirmVisible" :value="photo.id" :input-id="`recycle-photo-${photo.id}`" />
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
          <strong>将把 {{ recoveryPhotos.length }} 张照片恢复到 QQ 空间相册</strong>
          <p>恢复后这些照片会从回收站移除，并出现在你选择的相册里。恢复前请核对照片数量和目标相册。</p>
        </div>
      </div>

      <div class="dialog-tabs" role="tablist" aria-label="恢复目标">
        <button
          type="button"
          role="tab"
          :aria-selected="destinationMode === 'create'"
          :class="{ 'is-active': destinationMode === 'create' }"
          :disabled="recovering"
          @click="selectDestinationMode('create')"
        >
          新建相册
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="destinationMode === 'existing'"
          :class="{ 'is-active': destinationMode === 'existing' }"
          :disabled="recovering"
          @click="selectDestinationMode('existing')"
        >
          已有相册
        </button>
      </div>

      <div v-if="destinationMode === 'create'" class="dialog-field">
        <label for="recovery-album-name">相册名称</label>
        <InputText id="recovery-album-name" v-model="recoveryAlbumName" :disabled="recovering" maxlength="30" fluid />
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
            :disabled="recovering || !destinationAlbums.length"
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
      <!-- 部分成功时把「已成功恢复 N 张」显式说出来，重试只需处理剩下的照片。 -->
      <p v-if="error" class="dialog-error" role="alert">{{ describeError(error, '恢复未完成，请核对回收站和目标相册后重试。') }}</p>
      <p v-else-if="recoveredCount" class="dialog-note">本次已成功恢复 {{ recoveredCount }} 张照片，剩余照片可再次确认恢复。</p>

      <template #footer>
        <Button label="取消" severity="secondary" text :disabled="recovering" @click="closeRecoverDialog" />
        <Button
          label="确认恢复"

          :loading="recovering"
          :disabled="!canRecover || !recoverConfirmed || !recoveryPhotos.length || destinationLoading || (destinationMode === 'existing' ? !destinationAlbumId : !recoveryAlbumName.trim())"
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
        <Button label="确认恢复相册" :loading="albumRecovering" :disabled="!canRecover" @click="confirmAlbumRecover" ><template #icon><FolderOpen :size="16" :stroke-width="1.8" /></template></Button>
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

/* 说明列表的实际范围（后端固定取最近 18 张），避免「全部照片」被误解。 */
.list-note {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
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


/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .recycle-page { gap:var(--layout-page-gap); }
.album-item { min-height:var(--density-row-height); border-radius:var(--radius-md); padding:var(--space-3); }
.photo-card { border-radius:var(--radius-md); box-shadow:none; }
.mode-notice { border-radius:var(--radius-md); background:var(--color-surface-sunken); }
.photo-grid { gap:var(--space-3); }
@media(max-width:600px) { .photo-grid { gap:var(--space-2); } }
</style>
