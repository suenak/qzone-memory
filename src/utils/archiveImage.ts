import { fetch } from "@tauri-apps/plugin-http";

function isQqMissingImagePlaceholder(bytes: Uint8Array) {
  if (bytes.byteLength < 10) return false;
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  const width = bytes[6] + bytes[7] * 256;
  const height = bytes[8] + bytes[9] * 256;
  return (bytes.byteLength === 2_038 && header === "GIF89a" && width === 340 && height === 320)
    || (bytes.byteLength === 2_687 && header === "GIF89a" && width === 340 && height === 320)
    || (bytes.byteLength === 1_643 && header === "GIF87a" && width === 99 && height === 99)
    || (bytes.byteLength === 1_547 && header === "GIF87a" && width === 98 && height === 98);
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);

export async function loadRemoteImageBlob(url: string, signal?: AbortSignal) {
  // Old QQ records commonly contain HTTP or protocol-relative CDN addresses.
  const target = new URL(url.startsWith("//") ? `https:${url}` : url);
  if (target.username || target.password) throw new Error("图片地址不能包含账号信息");
  if (target.protocol === "http:" && target.hostname.split(".").slice(-2).join(".") === "qq.com") target.protocol = "https:";
  if (target.protocol === "http:" && ["qpic.cn", "qlogo.cn", "gtimg.com"].some(domain => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) target.protocol = "https:";
  if (target.protocol !== "https:") throw new Error("图片地址必须使用 HTTPS");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, 20_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(target.href, {
      method: "GET", signal: controller.signal, connectTimeout: 8_000,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", Referer: "https://user.qzone.qq.com/" },
    });
    reader = response.body?.getReader();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) throw new Error("QQ 返回了不支持的图片格式");
    const limit = 16 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) throw new Error("图片超过 16 MB，请下载原图查看");
    if (!reader) throw new Error("图片内容为空");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("图片超过 16 MB，请下载原图查看");
      chunks.push(new Uint8Array(value));
    }
    if (controller.signal.aborted) throw new DOMException("图片读取已取消", "AbortError");
    if (!length) throw new Error("图片内容为空");
    const blob = new Blob(chunks, { type: contentType });
    if (length < 3_000 && isQqMissingImagePlaceholder(new Uint8Array(await blob.arrayBuffer()))) throw new Error("QQ 原图已不存在");
    return URL.createObjectURL(blob);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
  }
}

/** Owns in-flight requests for a page or account. Clearing invalidates late results. */
export class ImageRequestScope {
  generation = 0;
  private requests = new Set<AbortController>();
  clear() {
    ++this.generation;
    this.requests.forEach((request) => request.abort());
    this.requests.clear();
  }
  async load(url: string) {
    const generation = this.generation;
    const request = new AbortController();
    this.requests.add(request);
    try {
      const source = await loadRemoteImageBlob(url, request.signal);
      if (generation !== this.generation) {
        URL.revokeObjectURL(source);
        throw new DOMException("图片读取已取消", "AbortError");
      }
      return source;
    } finally { this.requests.delete(request); }
  }
}

/** Matches the local-time filenames used by the native media store. */
export function mediaFileName(timestamp: number, suffix: string, extension = "jpg") {
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = timestamp > 0 && Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` : "时间未知";
  return `${stamp}_${suffix.replace(/[<>:"/\\|?*]/g, "_").slice(0,60)}.${extension}`;
}
