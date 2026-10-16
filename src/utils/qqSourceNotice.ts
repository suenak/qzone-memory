import { requiresQqLogin } from "./qqSession";

const unavailable = "部分历史暂时无法读取，已保存的内容可以正常查看。稍后可从当前位置继续。";

/** Presentation only: native diagnostics and checkpoints retain the actual cause. */
export function qqSourceNotice(reason: unknown): string | null {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  // A real expired session still needs the user's attention.
  if (requiresQqLogin(reason)) return null;
  if (/QQ_REQUEST_BLOCKED:|腾讯\s*WAF|HTTP\s*501\b|501\s+Not\s+Implemented|QQ_SOURCE_BUSY:/i.test(message)) {
    return unavailable;
  }
  return null;
}

export function qqProgressNotice(progress: { status: string; message: string; pages: number; saved: number }) {
  if (!["limited", "partial", "error"].includes(progress.status) || !qqSourceNotice(progress.message)) return null;
  return {
    title: progress.status === "partial" ? "本轮读取已结束" : "已暂停读取",
    description: unavailable,
    label: progress.status === "partial" ? "部分内容待读取" : "稍后继续",
    details: `已读取 ${progress.pages} 页，本轮已保存 ${progress.saved} 条记录。部分内容仍待读取，之后可继续。`,
  };
}
