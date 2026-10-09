import { isTauri } from "@tauri-apps/api/core";
import { platform as nativePlatform } from "@tauri-apps/plugin-os";

/** 浏览器只预览界面；原生平台仍由 Tauri 判断，不模拟原生接口或数据。 */
export function platform() {
  return isTauri() ? nativePlatform() : "browser";
}
