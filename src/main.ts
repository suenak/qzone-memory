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
      cssLayer: false,
    },
  },
});

app.mount("#app");
