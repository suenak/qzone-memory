import { invoke } from "./qqInvoke";

/** Display identity only. QQ cookies and derived tokens stay in Rust. */
export interface LoginIdentity { uin: string; }
export interface WebLoginStatus {
  status: "success" | "error" | "webLoginOpened" | "webLoginWaiting" | "webLoginCancelled";
  message: string;
  auth?: LoginIdentity;
}
export interface QzoneLoginUser { uin: string; nickname: string; avatarImage?: string; }
export const openWebLogin = () => invoke<WebLoginStatus>("open_web_login");
export const checkWebLogin = () => invoke<WebLoginStatus>("check_web_login");
export const syncCookiesToWebview = () => invoke<void>("sync_cookies_to_webview");
export const getQzoneLoginUser = () => invoke<QzoneLoginUser>("get_login_user");
