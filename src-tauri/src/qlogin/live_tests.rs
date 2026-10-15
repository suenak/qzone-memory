//! Explicitly opt-in diagnostics: use the signed-in Windows account without modifying it.
use super::*;

#[tokio::test]
#[ignore = "requires an authorised, signed-in Windows account and performs QQ GET requests"]
async fn signed_in_media_and_history_are_readable() {
    let state = QLoginState::new();
    assert!(
        state.restore_session().await.unwrap(),
        "no saved QQ session"
    );
    let auth = state.qzone_auth().await.unwrap();
    assert!(crate::account_storage::valid_uin(&auth.uin));
    let root = std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap())
        .join("top.ehre.qzonearchive/accounts")
        .join(format!("qq_{}", auth.uin));
    let db = rusqlite::Connection::open_with_flags(
        root.join("qzone-archive.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut statement = db.prepare("SELECT pictures_json FROM archive_dynamics WHERE owner_uin=?1 AND json_array_length(pictures_json,'$.picdata.pic')>0 ORDER BY id LIMIT 2").unwrap();
    let rows = statement
        .query_map([&auth.uin], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!rows.is_empty(), "no local picture samples");
    let owner_name = db.query_row("SELECT author_name FROM archive_dynamics WHERE owner_uin=?1 AND author_uin=?1 AND author_name IS NOT NULL LIMIT 1", [&auth.uin], |row| row.get::<_, String>(0)).ok();
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random).unwrap();
    let temp =
        std::env::temp_dir().join(format!("qza-live-images-{:x}", u64::from_le_bytes(random)));
    std::fs::create_dir(&temp).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(temp.clone());
    for (index, row) in rows.iter().enumerate() {
        let value: serde_json::Value = serde_json::from_str(row).unwrap();
        let candidates = value
            .pointer("/picdata/pic/0/photourl")
            .unwrap()
            .as_object()
            .unwrap()
            .values()
            .filter_map(|value| value["url"].as_str().map(str::to_owned))
            .collect();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(45),
            crate::media_store::download(&temp, &auth, candidates, 0, false),
        )
        .await
        .unwrap();
        let path = result.unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert!(crate::archive::archived_image_extension(&bytes).is_some());
        assert!(!crate::archive::is_qq_missing_image_placeholder(&bytes));
        eprintln!(
            "live image {}: {} bytes, valid image",
            index + 1,
            bytes.len()
        );
    }
    let result = crate::qzone::fetch_history_messages(&state, 0, 10, owner_name.as_deref()).await;
    if let Err(reason) = &result {
        let category = if (reason.starts_with("历史消息") || reason.starts_with("部分历史消息"))
            && !reason.contains("http")
        {
            reason.as_str()
        } else {
            "network or decoding failure"
        };
        eprintln!(
            "live history failure category: {category}; owner name available: {}",
            owner_name.is_some()
        );
    }
    assert!(result.is_ok(), "live history request or decoding failed");
    let page = result.ok().unwrap();
    eprintln!(
        "live history: {} records, {} reconstructed events",
        page.record_count,
        page.feeds.len()
    );
}
