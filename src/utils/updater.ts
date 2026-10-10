import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

/** 清单里描述的一个新版本。 */
export interface AvailableUpdate {
  version: string;
  notes?: string;
  /** 官网下载页；清单没给时回退到客户端内置的默认值。 */
  downloadPage?: string;
}

interface UpdateManifest {
  version?: string;
  notes?: string;
  download_page?: string;
}

/**
 * 比较版本号，返回 a 是否比 b 新。
 *
 * 只处理数字点分形式（本项目一直用 `主.次.修订`）。遇到预发布后缀等无法可靠比较的
 * 形式一律返回 false——宁可少提示一次，也不要让用户为一个并不存在的「新版本」去下载。
 */
function isNewer(a: string, b: string): boolean {
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
 * 更新说明与下载页，不请求任何安装包——安装包由用户自己去官网取。
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
  };
}

/** 打开官网下载页，交给系统浏览器处理。 */
export async function openDownloadPage(page?: string): Promise<void> {
  const target = page || (await fallbackDownloadPage());
  await openUrl(target);
}
