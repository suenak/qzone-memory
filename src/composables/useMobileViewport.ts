import { onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from "vue";

/** 只管理移动端可见高度，不改变输入焦点或任何账号、任务状态。 */
export function useMobileViewport(mobile: ComputedRef<boolean>) {
  const keyboardVisible = ref(false);
  let frame = 0;
  let idleHeight = 0;
  let layoutWidth = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      if (!mobile.value) return;
      // 放大阅读时保留布局尺寸，避免把缩放误判为软键盘。
      const unzoomed = !viewport || viewport.scale <= 1.01;
      const height = unzoomed ? (viewport?.height ?? window.innerHeight) : window.innerHeight;
      document.documentElement.style.setProperty("--mobile-viewport-height", `${height}px`);
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement &&
        (focused.matches("input:not([type=checkbox]):not([type=radio]), textarea") || focused.isContentEditable);
      // Android 原生边距可能同时缩小布局视口和可见视口；与输入前的高度比较。
      // 旋转或改变设备宽度时重新记录，避免将横屏误判为键盘。
      if (!editing || Math.abs(layoutWidth - window.innerWidth) > 1 || !idleHeight) {
        idleHeight = height;
        layoutWidth = window.innerWidth;
      }
      keyboardVisible.value = unzoomed && editing &&
        Math.max(window.innerHeight - height, idleHeight - height) > 120;
    });
  };
  onMounted(() => {
    window.visualViewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
  });
  watch(mobile, update);
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    window.visualViewport?.removeEventListener("resize", update);
    window.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    document.documentElement.style.removeProperty("--mobile-viewport-height");
  });
  return { keyboardVisible };
}
