import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

/** 清单里描述的一个新版本。 */
export interface AvailableUpdate {
  version: string;
  notes?: string;
  /** 官网下载页；清单没给时回退到客户端内置的默认值。 */
  downloadPage?: string;
  download?: { fileName: string; size?: number; platform: string };
  downloadError?: string;
}

interface UpdateManifest {
  version?: string;
  notes?: string;
  download_page?: string;
  download?: AvailableUpdate["download"];
  download_error?: string;
}

/**
 * 比较版本号，返回 a 是否比 b 新。
 *
 * 只处理数字点分形式（本项目一直用 `主.次.修订`）。遇到预发布后缀等无法可靠比较的
 * 形式一律返回 false——宁可少提示一次，也不要让用户为一个并不存在的「新版本」去下载。
 */
function isNewer(a: string, b: string): boolean {
  if (![a, b].every((version) => /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version))) return false;
  const left = a.split(".").map((part) => Number.parseInt(part, 10));
  const right = b.split(".").map((part) => Number.parseInt(part, 10));
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fallbackDownloadPage(): Promise<string> {
  return invoke<string>("download_page");
}

/**
 * 检查是否有新版本。
 *
 * 清单由授权服务端提供（见 `docs/RELEASE-AUTO-UPDATE.md`）。这里只读版本号、
 * 更新说明、平台安装包信息与备用下载页。下载在独立的原生命令中执行。
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  // 固定地址由 Rust 请求，不受 WebView 的 CSP/CORS 限制，也不开放任意网址访问权限。
  const manifest = await invoke<UpdateManifest | null>("fetch_update_manifest");
  if (!manifest?.version) return null;

  const current = await getVersion();
  if (!isNewer(manifest.version, current)) return null;

  return {
    version: manifest.version,
    notes: manifest.notes,
    downloadPage: manifest.download_page,
    download: manifest.download,
    downloadError: manifest.download_error,
  };
}

export interface UpdateDownloadProgress {
  status: "idle" | "preparing" | "downloading" | "verifying" | "completed" | "cancelled" | "error";
  version: string;
  fileName: string;
  downloaded: number;
  total?: number;
  message: string;
}
export const downloadUpdate = (version: string) => invoke<UpdateDownloadProgress>("download_update", { version });
export const getUpdateDownloadProgress = () => invoke<UpdateDownloadProgress>("get_update_download_progress");
export const cancelUpdateDownload = () => invoke("cancel_update_download");
export const openUpdatePackage = () => invoke("open_update_package");
export const revealUpdatePackage = () => invoke("reveal_update_package");

/** 打开官网下载页，交给系统浏览器处理。 */
export async function openDownloadPage(page?: string): Promise<void> {
  const target = page || (await fallbackDownloadPage());
  await openUrl(target);
}
