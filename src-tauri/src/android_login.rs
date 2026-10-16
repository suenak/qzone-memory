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
        // Tauri otherwise forwards unhandled mobile plugin commands from JS to
        // Kotlin. Only Rust's PluginHandle may read QQ cookies or vault values.
        .invoke_handler(|invoke| {
            invoke.resolver.reject("QQ 登录服务仅供原生客户端调用");
            true
        })
        .setup(|app, api| {
            let handle = api.register_android_plugin("top.ehre.qzonearchive", "QqLoginPlugin")?;
            app.manage(AndroidLogin(handle));
            crate::qlogin::init_android_storage(app.clone());
            Ok(())
        })
        .build()
}

pub(crate) fn session_storage(
    app: &tauri::AppHandle,
    command: &str,
    session: Option<String>,
) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct StoredSession {
        session: Option<String>,
    }
    app.state::<AndroidLogin>()
        .0
        .run_mobile_plugin::<StoredSession>(command, serde_json::json!({"session": session}))
        .map(|result| result.session)
        .map_err(|_| "无法访问安卓安全登录存储，请重新登录".to_owned())
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

pub fn open_update(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    app.state::<AndroidLogin>()
        .0
        .run_mobile_plugin::<serde_json::Value>(
            "openUpdate",
            serde_json::json!({"path":path.to_string_lossy()}),
        )
        .map(|_| ())
        .map_err(|_| "无法打开安装包，请允许拾忆安装应用后重试".to_owned())
}
