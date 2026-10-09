import { ref } from "vue";

export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

/**
 * 全局 Toast 队列。
 *
 * 刻意做成模块级单例而不是 Pinia store：它只是一个渲染队列，
 * 没有需要参与状态持久化或调试追踪的业务含义。
 */
const items = ref<ToastItem[]>([]);
let sequence = 0;

function dismiss(id: number) {
  items.value = items.value.filter((item) => item.id !== id);
}

function push(message: string, tone: ToastTone, duration: number) {
  // 同一条消息连点两次时不重复堆叠，只刷新寿命。
  const existing = items.value.find((item) => item.message === message && item.tone === tone);
  if (existing) {
    dismiss(existing.id);
  }

  const id = ++sequence;
  items.value = [...items.value, { id, tone, message }];
  if (duration > 0) {
    window.setTimeout(() => dismiss(id), duration);
  }
  return id;
}

/**
 * 轻量提示。
 *
 * 使用克制：成功提示 3 秒自动消失，错误提示留久一些（用户需要读完），
 * 且绝不用于承载「必须被看到」的关键信息——那类信息应该直接渲染在页面上。
 */
export function useToast() {
  return {
    items,
    dismiss,
    info: (message: string) => push(message, "info", 3000),
    success: (message: string) => push(message, "success", 3000),
    error: (message: string) => push(message, "error", 5200),
  };
}
