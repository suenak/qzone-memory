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

export async function loadRemoteImageBlob(url: string) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      Referer: "https://user.qzone.qq.com/",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.toLowerCase().startsWith("image/")) throw new Error(`QQ 返回了非图片内容（${contentType}）`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (isQqMissingImagePlaceholder(bytes)) throw new Error("QQ 原图已不存在");
  return URL.createObjectURL(new Blob([buffer], { type: contentType }));
}

/** Matches the local-time filenames used by the native media store. */
export function mediaFileName(timestamp: number, suffix: string, extension = "jpg") {
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = timestamp > 0 && Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` : "时间未知";
  return `${stamp}_${suffix.replace(/[<>:"/\\|?*]/g, "_").slice(0,60)}.${extension}`;
}
