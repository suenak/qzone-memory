import { nextTick, onBeforeUnmount, watch, type Ref } from "vue";

/** 自绘图片预览与系统弹窗一样：限制焦点、Esc 关闭、退出后回到触发控件。 */
export function usePreviewFocus(open: Readonly<Ref<boolean>>, close: () => void) {
  let origin: HTMLElement | null = null;
  let app: HTMLElement | null = null;
  let wasInert = false;
  let active = false;
  const overlay = () => {
    const overlays = document.querySelectorAll<HTMLElement>("[data-qza-preview]");
    return overlays[overlays.length - 1];
  };
  function restore() {
    document.removeEventListener("keydown", keyboard, true);
    if (!active) return;
    active = false;
    if (app) app.inert = wasInert;
    if (origin?.isConnected) origin.focus({ preventScroll: true });
  }
  function keyboard(event: KeyboardEvent) {
    const root = overlay();
    if (!root) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), [tabindex='0']"))
      .filter(element => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) { event.preventDefault(); root.focus(); return; }
    if (!root.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }
  watch(open, async (visible) => {
    if (!visible) { restore(); return; }
    origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    if (!open.value) return;
    app = document.getElementById("app");
    wasInert = app?.inert ?? false;
    active = true;
    if (app) app.inert = true;
    const root = overlay();
    (root?.querySelector<HTMLElement>("button:not(:disabled)") ?? root)?.focus({ preventScroll: true });
    document.addEventListener("keydown", keyboard, true);
  });
  onBeforeUnmount(restore);
}
