<script setup lang="ts">
import { ref, reactive, watch, onMounted, onBeforeUnmount } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { ChevronLeft, ChevronRight, X, Minus, Plus, RotateCw, RotateCcw, Download, LoaderCircle, RefreshCw } from "lucide-vue-next";
import { usePreviewFocus } from "../composables/usePreviewFocus";
import { computed } from "vue";
const props = withDefaults(defineProps<{ src?: string; name?: string; title?: string; index?: number; total?: number; loading?: boolean; error?: string }>(), { src: "", name: "空间照片.jpg", title: "查看照片", index: 0, total: 1, loading: false, error: "" });
const emit = defineEmits<{ close: []; step: [delta: number]; retry: []; saved: []; error: [message: string] }>();
usePreviewFocus(computed(() => true), () => { if (sheet.value) sheet.value = false; else emit("close"); });
const scale = ref(1), rotation = ref(0), saving = ref(false), sheet = ref(false), imageFailed = ref(false);
const stage = ref<HTMLElement>(), picture = ref<HTMLImageElement>();
const rotationFit = ref(1);
function fitRotation() {
  const img = picture.value, frame = stage.value;
  rotationFit.value = img && frame && rotation.value % 180 !== 0 ? Math.min(1, frame.clientWidth / img.clientHeight, frame.clientHeight / img.clientWidth) : 1;
}
watch(rotation, fitRotation);
onMounted(() => window.addEventListener("resize", fitRotation));
const offset = reactive({x: 0, y: 0});
const pointers = new Map<number, {x: number; y: number}>();
let drag: {x: number; y: number; ox: number; oy: number} | undefined;
let pinch: {distance: number; scale: number} | undefined;
let hold: ReturnType<typeof setTimeout> | undefined;
function clearHold() { if (hold) clearTimeout(hold); hold = undefined; }
function reset() { scale.value = 1; rotation.value = 0; rotationFit.value = 1; offset.x = offset.y = 0; pointers.clear(); drag = undefined; pinch = undefined; clearHold(); sheet.value = false; }
watch(() => [props.src, props.index], () => { reset(); imageFailed.value = false; });
function zoom(value: number) { scale.value = Math.max(0.5, Math.min(5, value)); if (scale.value <= 1) offset.x = offset.y = 0; }
function distance() { const p = [...pointers.values()]; return p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0; }
function down(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  drag = {x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y};
  clearHold();
  if (pointers.size === 2) pinch = {distance: distance(), scale: scale.value};
  else if (e.pointerType !== "mouse") hold = setTimeout(() => { sheet.value = true; }, 550);
}
function move(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return;
  if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 7) clearHold();
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (pointers.size > 1 && pinch?.distance) zoom(pinch.scale * distance() / pinch.distance);
  else if (scale.value > 1 && drag) { offset.x = drag.ox + e.clientX - drag.x; offset.y = drag.oy + e.clientY - drag.y; }
}
function up(e: PointerEvent) {
  clearHold(); pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = undefined;
  const remaining = [...pointers.values()][0];
  drag = remaining ? {x: remaining.x, y: remaining.y, ox: offset.x, oy: offset.y} : undefined;
}
async function saveImage() {
  if (!props.src || saving.value) return;
  saving.value = true;
  try {
    const response = await window.fetch(props.src);
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error();
    const ext = ({"image/png":"png", "image/webp":"webp", "image/gif":"gif", "image/avif":"avif", "image/bmp":"bmp", "image/x-ms-bmp":"bmp"} as Record<string,string>)[blob.type] || "jpg";
    const name = props.name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g,"_") + "." + ext;
    const path = await save({defaultPath: name, filters:[{name:"图片", extensions:[ext]}]});
    if (!path) return;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    emit("saved"); sheet.value = false;
  } catch { emit("error", "图片没有保存成功，请重试。"); }
  finally { saving.value = false; }
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); sheet.value ? sheet.value = false : emit("close"); }
  if (e.key === "ArrowLeft" && props.total > 1) { e.preventDefault(); emit("step", -1); }
  if (e.key === "ArrowRight" && props.total > 1) { e.preventDefault(); emit("step", 1); }
}
onBeforeUnmount(() => { clearHold(); window.removeEventListener("resize", fitRotation); });
</script>
<template>
  <Teleport to="body">
    <div class="viewer" data-qza-preview tabindex="-1" role="dialog" aria-modal="true" :aria-label="title" @keydown="key" @click.self="emit('close')">
      <header><span>{{ title }}</span><span v-if="total > 1">{{ index + 1 }} / {{ total }}</span><button type="button" aria-label="关闭预览" @click="emit('close')"><X :size="20" :stroke-width="1.8" /></button></header>
      <div ref="stage" class="stage" @wheel.prevent="zoom(scale * ($event.deltaY < 0 ? 1.15 : 0.87))">
        <button v-if="total > 1" class="previous" type="button" aria-label="上一张" @click="emit('step', -1)"><ChevronLeft :size="22" :stroke-width="1.8" /></button>
        <img ref="picture" v-if="src && !imageFailed" @load="fitRotation" :src="src" :alt="title" draggable="false" :style="{transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale * rotationFit}) rotate(${rotation}deg)`}" @dblclick.prevent="scale > 1 ? reset() : zoom(2)" @pointerdown.prevent="down" @pointermove.prevent="move" @pointerup="up" @pointercancel="up" @error="imageFailed = true" />
        <div v-else class="fallback" role="status"><LoaderCircle v-if="loading" class="spin" :size="24" :stroke-width="1.8" /><p>{{ loading ? '正在读取图片…' : error || '这张图片暂时无法显示' }}</p><button v-if="!loading" type="button" @click="imageFailed = false; emit('retry')"><RefreshCw :size="16" :stroke-width="1.8" />重新读取</button></div>
        <button v-if="total > 1" class="next" type="button" aria-label="下一张" @click="emit('step', 1)"><ChevronRight :size="22" :stroke-width="1.8" /></button>
      </div>
      <footer>
        <div class="tools"><button type="button" aria-label="缩小" @click="zoom(scale / 1.25)"><Minus :size="18" :stroke-width="1.8" /></button><span>{{ Math.round(scale * 100) }}%</span><button type="button" aria-label="放大" @click="zoom(scale * 1.25)"><Plus :size="18" :stroke-width="1.8" /></button><button type="button" aria-label="向右旋转90度" @click="rotation = (rotation + 90) % 360"><RotateCw :size="18" :stroke-width="1.8" /></button><button type="button" aria-label="复位" @click="reset"><RotateCcw :size="18" :stroke-width="1.8" /></button><button type="button" aria-label="保存图片" :disabled="!src || imageFailed || saving" @click="saveImage"><LoaderCircle v-if="saving" class="spin" :size="18" :stroke-width="1.8" /><Download v-else :size="18" :stroke-width="1.8" /></button></div>
        <p>双击或双指缩放 · 长按保存</p><slot />
      </footer>
      <div v-if="sheet" class="sheet-mask" @click.self="sheet = false"><div class="sheet"><button type="button" :disabled="saving" @click="saveImage">{{ saving ? '正在保存…' : '保存图片' }}</button><button type="button" @click="sheet = false">取消</button></div></div>
    </div>
  </Teleport>
</template>
<style scoped>
.viewer { position:fixed; inset:0; z-index:var(--z-preview); display:flex; flex-direction:column; background:var(--color-surface); color:var(--color-text); padding:var(--space-4); gap:var(--space-3); }
header {display:flex; align-items:center; gap:var(--space-3); font-size:var(--text-sm); min-height:var(--space-10);}
header span:first-child {flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;}
button {display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2); min-width:var(--space-10); min-height:var(--space-10); border:1px solid var(--color-border); border-radius:var(--radius-md); color:var(--color-text); background:var(--color-surface-raised); cursor:pointer;}
button:disabled {opacity:.45; cursor:default;} button:focus-visible {outline:2px solid var(--color-accent); outline-offset:2px;}
.stage {position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; overflow:hidden;}
.stage img {max-width:100%; max-height:100%; object-fit:contain; touch-action:none; user-select:none;}
.previous,.next {position:absolute; top:50%; z-index:1;} .previous {left:0;} .next {right:0;}
footer {display:flex; flex-direction:column; align-items:center; gap:var(--space-2);}
footer p {margin:0; color:var(--color-text-secondary); font-size:var(--text-xs);}
.tools {display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap; justify-content:center;}
.tools span {font-variant-numeric:tabular-nums; min-width:var(--space-12); text-align:center;}
.fallback {text-align:center; color:var(--color-text-secondary);}
.sheet-mask {position:absolute; inset:0; background:var(--color-overlay); display:flex; align-items:end;}
.sheet {width:100%; padding:var(--space-4); background:var(--color-surface); display:grid; gap:var(--space-2);}
.spin {animation:spin 1s linear infinite;} @keyframes spin {to {transform:rotate(360deg);}}
@media(max-width:600px) {.viewer {padding:var(--space-2);} button {min-width:var(--control-height);min-height:var(--control-height);} .tools {gap:var(--space-1);} }
@media(prefers-reduced-motion:reduce) {.spin {animation:none;}}
</style>
