export function detectDevicePlatform(device = navigator) {
  const ua = device.userAgent || "";
  const platform = device.userAgentData?.platform || device.platform || "";
  // iPadOS can identify itself as a Mac when requesting desktop websites.
  if (
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Mac/i.test(platform + ua) && device.maxTouchPoints > 1)
  )
    return "ios";
  if (/Android/i.test(ua + platform)) return "android";
  if (/Win/i.test(platform + ua)) return "windows";
  if (/Mac/i.test(platform + ua)) return "macos";
  return null;
}

export function initializeMarketing(root) {
  if (!root) return () => {};
  const cleanups = [];
  const listen = (element, event, callback) => {
    if (!element) return;
    element.addEventListener(event, callback);
    cleanups.push(() => element.removeEventListener(event, callback));
  };
  const nav = root.querySelector("[data-nav]");
  const toggle = root.querySelector("[data-menu-toggle]");
  const closeMenu = () => {
    nav?.classList.remove("menu-open");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", "打开导航");
  };
  listen(toggle, "click", () => {
    const open = nav.classList.toggle("menu-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  });
  listen(root, "click", (event) => {
    if (
      event.target.closest(".nav-menu a") ||
      (nav?.classList.contains("menu-open") && !event.target.closest(".nav"))
    )
      closeMenu();
  });
  listen(document, "keydown", (event) => {
    if (event.key === "Escape" && nav?.classList.contains("menu-open")) {
      closeMenu();
      toggle.focus();
    }
  });
  const onResize = () => {
    if (innerWidth > 900) closeMenu();
  };
  listen(window, "resize", onResize);
  function tabGroup(selector, panelSelector, key) {
    const buttons = [...root.querySelectorAll(selector)];
    const panels = [...root.querySelectorAll(panelSelector)];
    const select = (button) => {
      for (const item of buttons) {
        const active = item === button;
        item.setAttribute("aria-selected", String(active));
        item.tabIndex = active ? 0 : -1;
      }
      for (const panel of panels)
        panel.hidden = panel.dataset[key + "Panel"] !== button.dataset[key];
      if (key === "os") {
        const label = root.querySelector("[data-download-label]");
        if (label) label.textContent = `下载 ${button.textContent.trim()} 版`;
        const note = root.querySelector("[data-device-note]");
        if (note) note.textContent = `当前选择 ${button.textContent.trim()}，也可以切换其他平台。`;
      }
    };
    if (key === "os") {
      const platform = new URLSearchParams(location.search).get("platform");
      const detected = detectDevicePlatform();
      const requested = buttons.find(
        (button) => button.dataset.os === platform,
      );
      const initial =
        requested ||
        buttons.find((button) => button.dataset.os === detected) ||
        buttons[0];
      if (initial) select(initial);
      const note = root.querySelector("[data-device-note]");
      const deviceLabel = buttons
        .find((button) => button.dataset.os === detected)
        ?.textContent.trim();
      if (note)
        note.textContent = requested
          ? `已按链接选择 ${requested.textContent.trim()}，也可以切换其他平台。`
          : deviceLabel
            ? `已为你选择 ${deviceLabel}，也可以切换其他平台。`
            : "请选择需要下载的平台。";
    }
    for (const button of buttons) {
      const panel = panels.find(
        (item) => item.dataset[key + "Panel"] === button.dataset[key],
      );
      button.id = key + "-tab-" + button.dataset[key];
      if (panel) {
        panel.id = panel.id || key + "-panel-" + button.dataset[key];
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", button.id);
        button.setAttribute("aria-controls", panel.id);
      }
      listen(button, "click", () => select(button));
      listen(button, "keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const index = buttons.indexOf(button);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        select(buttons[next]);
        buttons[next].focus();
      });
    }
  }
  tabGroup("[data-preview]", "[data-preview-panel]", "preview");
  tabGroup("[data-os]", "[data-os-panel]", "os");
  const elements = [...root.querySelectorAll(".reveal")];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window))
    elements.forEach((el) => el.classList.add("in"));
  else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.06 },
    );
    elements.forEach((el) => observer.observe(el));
    cleanups.push(() => observer.disconnect());
  }
  root.classList.add("ready");
  return () => {
    cleanups.forEach((fn) => fn());
    closeMenu();
  };
}
if (
  typeof document !== "undefined" &&
  document.body.classList.contains("marketing-site")
)
  initializeMarketing(document.body);
