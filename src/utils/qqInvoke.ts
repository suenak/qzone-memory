import { invoke as nativeInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { qqSession } from "./qqSession";

export function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  return qqSession.request(() => nativeInvoke<T>(command, args), command === "start_feed_archive");
}
