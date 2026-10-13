//! Android main-thread WebView bridge, callable only through guarded Rust commands.
use serde::Deserialize;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Wry,
};

pub struct AndroidLogin(pub PluginHandle<Wry>);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogin {
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub cookie_header: String,
    #[serde(default)]
    pub user_agent: String,
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("qq-login-native")
        .setup(|app, api| {
            let handle = api.register_android_plugin("top.ehre.qzonearchive", "QqLoginPlugin")?;
            app.manage(AndroidLogin(handle));
            Ok(())
        })
        .build()
}

pub fn call(app: &tauri::AppHandle, command: &str) -> Result<NativeLogin, String> {
    app.state::<AndroidLogin>()
        .0
        .run_mobile_plugin(command, serde_json::json!({}))
        .map_err(|_| "安卓登录服务暂时不可用，请重新打开登录页".to_owned())
}
pub fn cancel(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<AndroidLogin>()
        .0
        .run_mobile_plugin::<serde_json::Value>("cancel", serde_json::json!({}))
        .map(|_| ())
        .map_err(|_| "无法关闭登录页".to_owned())
}
