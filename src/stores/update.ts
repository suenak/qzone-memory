import { defineStore } from "pinia";
import { ref } from "vue";
import { checkForUpdate, openDownloadPage, type AvailableUpdate } from "../utils/updater";
import { describeError } from "../utils/uiError";

/**
 * 版本更新状态。
 *
 * 检查有两个入口：应用启动时的静默检查，以及设置页里用户主动点的检查。
 * 两者共用同一个弹窗，所以状态放在这里而不是设置页组件内——启动检查发生时
 * 设置页根本没有挂载，弹窗必须由 App.vue 渲染。
 */
export const useUpdateStore = defineStore("update", () => {
  const available = ref<AvailableUpdate | null>(null);
  const checking = ref(false);
  const message = ref("");
  const dialogVisible = ref(false);

  /**
   * 检查是否有新版本。
   *
   * `silent` 为 true（启动检查）时，「已是最新」与失败都不写任何文案：用户刚打开
   * 应用，没必要因为没联网、或服务端还没部署就看到一条与当前操作无关的提示。
   * 但**有新版时仍然弹窗**——那正是需要他知道的信息。
   */
  async function check(options: { silent?: boolean } = {}) {
    if (checking.value) return;
    checking.value = true;
    if (!options.silent) message.value = "";
    try {
      const found = await checkForUpdate();
      if (found) {
        available.value = found;
        message.value = `发现新版本 ${found.version}`;
        dialogVisible.value = true;
      } else if (!options.silent) {
        message.value = "当前已是最新版本。";
      }
    } catch (reason) {
      // 静默检查失败保持沉默；只有用户主动点击时才回显原因，否则他无从判断该不该重试。
      if (!options.silent) message.value = describeError(reason, "检查更新失败，请稍后重试。");
    } finally {
      checking.value = false;
    }
  }

  /** 打开官网下载页。装不装、什么时候装都由用户决定，应用不参与安装。 */
  async function goToDownloadPage() {
    try {
      await openDownloadPage(available.value?.downloadPage);
      dialogVisible.value = false;
    } catch (reason) {
      message.value = describeError(reason, "无法打开下载页，请手动访问官网。");
    }
  }

  return { available, checking, message, dialogVisible, check, goToDownloadPage };
});
