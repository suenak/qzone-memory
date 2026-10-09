const blockedKeys = new Set(["F1"]);
// 保留浏览器来源快捷键限制；缩放和复制不拦截，允许大字号与辅助技术。
const blockedCtrlKeys = new Set(["u"]);
const blockedDevtoolKeys = new Set(["i", "j", "c"]);

export function installAppGuards() {
  document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const blocksZoomOrSource = (event.ctrlKey || event.metaKey) && blockedCtrlKeys.has(key);
    const blocksDevtools = (event.ctrlKey || event.metaKey) && event.shiftKey && blockedDevtoolKeys.has(key);
    if (blockedKeys.has(event.key) || blocksZoomOrSource || blocksDevtools) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true });

}
