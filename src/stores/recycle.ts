import { defineStore } from "pinia";
import { ref } from "vue";

// Kept in memory only. The temporary QQ signature is never persisted to disk.
export const useRecycleSessionStore = defineStore("recycle-session", () => {
  const pwd2sig = ref("");
  const ownerUin = ref("");
  let windowQueue = Promise.resolve();

  // Shared across page instances: an old close must finish before a new window
  // opens, including when a page is left while the native open is still pending.
  function withVerificationWindow<T>(operation: () => Promise<T>): Promise<T> {
    const request = windowQueue.then(operation);
    windowQueue = request.then(() => {}, () => {});
    return request;
  }

  function setVerified(token: string, uin: string) {
    pwd2sig.value = token;
    ownerUin.value = uin;
  }

  function clear() {
    pwd2sig.value = "";
    ownerUin.value = "";
  }

  return { pwd2sig, ownerUin, setVerified, clear, withVerificationWindow };
});
