mod archive;
mod license;
mod media_http;
mod qlogin;
mod qzone;

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(archive::ArchiveState::new())
        .manage(qlogin::QLoginState::new())
        .manage(qzone::RecycleAuthState::default())
        .manage(qzone::QzonePageTokenState::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 授权状态在建窗之前完成初始化，各命令守卫因此无需关心初始化时机。
            license::initialize(app.handle());
            license::spawn_heartbeat(app.handle().clone());

            // 生产构建必须关闭 devtools：它能在控制台直接调用全部后端命令，
            // 会让前端的授权闸门形同虚设。开发构建自动打开以便调试。
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            exit_app,
            license::get_license_status,
            license::activate_license,
            license::refresh_license,
            license::list_license_seats,
            license::deactivate_license_seat,
            license::redeem_license_code,
            license::sign_out_license,
            qlogin::start_qr_login,
            qlogin::poll_qr_login,
            qlogin::get_login_status,
            qlogin::logout_qzone,
            qlogin::open_web_login,
            qlogin::check_web_login,
            qlogin::sync_cookies_to_webview,
            qzone::fetch_first_feeds,
            qzone::fetch_more_feeds,
            qzone::open_recycle_password_window,
            qzone::prepare_recycle_password_window,
            qzone::check_recycle_password,
            qzone::close_recycle_password_window,
            qzone::list_recycle_albums,
            qzone::list_recycle_photos,
            qzone::load_recycle_photo_preview,
            qzone::list_qzone_albums,
            qzone::create_qzone_album,
            qzone::recover_recycle_album,
            qzone::recover_recycle_photos,
            archive::start_feed_archive,
            archive::get_archive_progress,
            archive::cancel_feed_archive,
            archive::list_archive_skips,
            archive::retry_archive_skip,
            archive::list_archived_feeds,
            archive::list_archive_years,
            archive::list_archived_media,
            archive::get_archived_feed,
            archive::count_archived_feeds,
            archive::export_archived_html,
            archive::load_archived_image,
            archive::load_archived_video,
            archive::get_archive_overview,
            archive::list_interactors,
            archive::list_contact_comment_threads,
            archive::sync_qzone_library,
            archive::list_qzone_library,
            archive::list_qzone_library_years,
            archive::get_interaction_ranking,
            archive::delete_archived_feeds,
            archive::clear_archived_feeds,
            archive::delete_all_app_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
