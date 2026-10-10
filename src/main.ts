import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Aura from "@primevue/themes/aura";
import App from "./App.vue";
import router from "./router";
import { pinia } from "./stores";
import { useAppStore } from "./stores/app";
import { installAppGuards } from "./utils/appGuards";
import { zhLocale } from "./utils/primeLocale";
// 全局样式入口：base 引入设计变量和组件库适配；页面样式使用 scoped style。
import "./styles/base.css";

installAppGuards();
const app = createApp(App);

app.use(pinia);
app.use(router);

// 立即应用主题。
// 初始化时 AppShell 尚未挂载，主题类必须提前落到 <html> 上，
// 否则激活页与免责声明会永远停在浅色，与系统设置不符。
useAppStore();

app.use(PrimeVue, {
  locale: zhLocale,
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: ".app-dark",
      // 把 PrimeVue 的运行时样式收进低优先级的 CSS layer。
      // 否则它以 head.appendChild 注入、排在 Vite 样式表之后，会用同特异性
      // 覆盖 base.css 里的设计令牌适配（实测 .p-button / .p-select / .p-drawer 等）。
      // 未分层的样式天然优先于任何 layer，这样令牌映射才能稳定生效。
      cssLayer: { name: "primevue", order: "primevue" },
    },
  },
});

app.mount("#app");
