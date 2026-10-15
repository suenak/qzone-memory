use super::*;

fn database() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    initialize_database(&mut connection).unwrap();
    connection
}

fn feed(key: &str, cell: &str, kind: i64, time: i64) -> Value {
    json!({
        "comm": {"feedskey": key, "subid": kind, "time": time},
        "userinfo": {"user": {"uin": "456", "nickname": "朋友"}},
        "summary": {"summary": "评论正文"},
        "original": {
            "cell_id": {"cellid": cell},
            "cell_comm": {"appid": 311, "time": 100},
            "cell_userinfo": {"user": {"uin": "123", "nickname": "本人"}},
            "cell_summary": {"summary": "  原来的正文  "},
            "cell_pic": {"picdata": {"pic": [{"photourl": [{"url": "https://example.com/photo.jpg"}]}]}},
            "cell_video": {"videourl": "https://example.com/video.mp4"},
            "cell_comment": {"main_comment": {
                "commentid": key, "content": "评论正文", "date": time,
                "user": {"uin": "456", "nickname": "朋友"},
                "replys": [{"content": "回复正文", "date": time + 1, "user": {"uin": "123"}}]
            }}
        }
    })
}

fn save(connection: &mut Connection, owner: &str, feeds: &[Value]) {
    save_retried_rows(connection, owner, feeds).unwrap();
}

#[test]
fn sparse_refresh_keeps_original_media_author_comments_and_replies() {
    let mut connection = database();
    save(&mut connection, "123", &[feed("comment-1", "post", 2, 200)]);
    let sparse = json!({
        "comm": {"feedskey": "comment-1", "subid": 2, "time": 200},
        "userinfo": {"user": {"uin": "456", "nickname": ""}},
        "original": {
            "cell_id": {"cellid": "post"}, "cell_comm": {"time": 0},
            "cell_summary": {"summary": "  "}, "cell_userinfo": null,
            "cell_pic": {"picdata": {"pic": []}}, "cell_video": {},
            "cell_comment": {"main_comment": {"replys": []}}
        }
    });
    save(&mut connection, "123", &[sparse]);
    let items = archive_items_for_export(&connection, "123", "self", None).unwrap();
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.content.as_deref(), Some("  原来的正文  "));
    assert_eq!(item.author_name.as_deref(), Some("本人"));
    assert_eq!(item.published_at, 100);
    assert_eq!(item.picture_urls, ["https://example.com/photo.jpg"]);
    assert_eq!(
        item.video_url.as_deref(),
        Some("https://example.com/video.mp4")
    );
    assert_eq!(item.comment_count, 2);
    assert_eq!(item.comments[0].replies[0].content, "回复正文");
    // A separate endpoint refreshes usable values without destroying the old media.
    let mut fresh = feed("comment-2", "post", 2, 300);
    fresh["original"]["cell_summary"]["summary"] = json!("后来更新的正文");
    fresh["original"]["cell_pic"] = Value::Null;
    save(&mut connection, "123", &[fresh]);
    let items = archive_items_for_export(&connection, "123", "self", None).unwrap();
    assert_eq!(items[0].content.as_deref(), Some("后来更新的正文"));
    assert_eq!(items[0].picture_urls.len(), 1);
}

#[test]
fn empty_object_does_not_replace_a_legacy_array_snapshot() {
    let mut stored = json!({"cell_video": [{"videourl": "https://example.com/video.mp4"}]});
    let expected = stored.clone();
    merge_recovery_snapshot(&mut stored, &json!({"cell_video": {}}));
    assert_eq!(stored, expected);
}

#[test]
fn unreadable_existing_snapshot_rolls_back_the_whole_page() {
    let mut connection = database();
    save(&mut connection, "123", &[feed("old", "post", 2, 100)]);
    connection
        .execute("UPDATE archive_feeds SET raw_json='broken'", [])
        .unwrap();
    assert!(save_retried_rows(
        &mut connection,
        "123",
        &[feed("new", "new-post", 2, 200), feed("old", "post", 2, 300),]
    )
    .is_err());
    for table in ["archive_feeds", "archive_dynamics"] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT raw_json FROM archive_feeds WHERE feed_key='old'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "broken"
    );
}

#[test]
fn hash_only_history_is_not_deleted_by_a_matching_visible_body() {
    let mut connection = database();
    let visible = feed("visible", "post", 311, 200);
    let mut historical = feed("history-v2-event:old", "history-v2:unknown", 217, 300);
    historical["original"]["cell_comm"]["time"] = json!(0);
    save(&mut connection, "123", &[visible, historical]);
    let items = archive_items_for_export(&connection, "123", "self", None).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items
            .iter()
            .find(|item| item.cell_id.starts_with("history-v2:"))
            .unwrap()
            .published_at,
        0
    );
    assert_eq!(
        items
            .iter()
            .find(|item| item.cell_id == "post")
            .unwrap()
            .like_count,
        0
    );
    // Both sources with a real shared ID still form one post.
    save(
        &mut connection,
        "123",
        &[feed("history-v2-event:known", "post", 217, 400)],
    );
    let items = archive_items_for_export(&connection, "123", "self", None).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items
            .iter()
            .find(|item| item.cell_id == "post")
            .unwrap()
            .like_count,
        1
    );
}

#[test]
fn distinct_comment_ids_keep_identical_text_sent_in_the_same_second() {
    let comments = ["first", "second", "first"].map(|id| comment_from_values(
        Some(json!({"main_comment": {"commentid": id, "content": "相同正文", "date": 100, "user": {"uin": "456"}}}).to_string()),
        None, None, None, 100,
    ));
    assert_eq!(merge_comments(comments).len(), 2);
}

#[test]
fn migration_row_failure_does_not_set_completion_marker_or_delete_data() {
    let mut connection = database();
    save(&mut connection, "123", &[feed("event", "post.1", 2, 200)]);
    connection
        .execute(
            "DELETE FROM archive_migrations WHERE name='canonical-qzone-mood-aliases-v1'",
            [],
        )
        .unwrap();
    connection
        .execute("UPDATE archive_dynamics SET content=x'ff'", [])
        .unwrap();
    assert!(migrate_qzone_mood_aliases(&mut connection).is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM archive_dynamics WHERE cell_id='post.1'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM archive_migrations WHERE name='canonical-qzone-mood-aliases-v1'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn invalid_migration_json_rolls_back_and_can_be_retried_after_repair() {
    let mut connection = database();
    connection
        .execute(
            "DELETE FROM archive_migrations WHERE name='library-guestbook-timestamps-v1'",
            [],
        )
        .unwrap();
    connection.execute("INSERT INTO archive_library_items(owner_uin,module,item_key,raw_json,created_at,archived_at) VALUES ('123','guestbook','bad','broken',0,0)", []).unwrap();
    assert!(migrate_library_guestbook_timestamps(&mut connection).is_err());
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM archive_migrations WHERE name='library-guestbook-timestamps-v1'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    connection
        .execute("UPDATE archive_library_items SET raw_json='{}'", [])
        .unwrap();
    migrate_library_guestbook_timestamps(&mut connection).unwrap();
}

#[test]
fn unreadable_interactions_fail_export_instead_of_disappearing() {
    let mut connection = database();
    save(&mut connection, "123", &[feed("comment", "post", 2, 200)]);
    connection
        .execute("UPDATE archive_feeds SET event_time=x'ff'", [])
        .unwrap();
    assert!(archive_items_for_export(&connection, "123", "self", None)
        .err()
        .unwrap()
        .contains("读取互动记录失败"));
}

#[test]
fn batched_interactions_cross_chunk_boundaries_and_keep_accounts_separate() {
    let mut connection = database();
    let feeds: Vec<_> = (0..405)
        .flat_map(|index| {
            let cell = format!("post-{index}");
            [
                feed(&format!("comment-{index}"), &cell, 2, 200),
                feed(&format!("history-v2-event:like-{index}"), &cell, 217, 201),
                feed(&format!("like-{index}"), &cell, 217, 202),
            ]
        })
        .collect();
    save(&mut connection, "123", &feeds);
    save(
        &mut connection,
        "999",
        &[feed("unrelated", "post-0", 2, 100)],
    );
    let mut items = archive_items_for_export(&connection, "123", "self", None).unwrap();
    assert_eq!(items.len(), 405);
    for item in &items {
        assert_eq!(item.comment_count, 2);
        assert_eq!(item.like_count, 1);
        assert!(!item.likes[0].historical);
    }
    // An account with the same cell ID must not receive the other account's likes.
    let other = archive_items_for_export(&connection, "999", "other", None)
        .unwrap()
        .pop()
        .unwrap();
    items.push(other);
    hydrate_archive_item_interactions(&connection, &mut items).unwrap();
    assert_eq!(items.last().unwrap().like_count, 0);
    assert_eq!(items.last().unwrap().comment_count, 2);
    hydrate_archive_item_interactions(&connection, &mut []).unwrap();
}

// Retain the previous indexed, prepared-statement approach as a benchmark
// baseline. Timing is reported, never used as a flaky CI assertion.
fn hydrate_one_at_a_time(connection: &Connection, items: &mut [ArchiveItem]) {
    let mut comments = connection.prepare(
        "SELECT comments_json,actor_uin,actor_name,event_summary,event_time FROM archive_feeds
         WHERE owner_uin=?1 AND cell_id=?2 AND event_type IN (2,311) ORDER BY event_time ASC,id ASC"
    ).unwrap();
    let mut likes = connection.prepare(
        "SELECT actor_uin,actor_name,
         (feed_key LIKE 'history-v2-event:%' OR feed_key LIKE 'history-event:%'),event_time
         FROM archive_feeds WHERE owner_uin=?1 AND cell_id=?2 AND event_type=217
         ORDER BY (feed_key LIKE 'history-v2-event:%' OR feed_key LIKE 'history-event:%') ASC,event_time ASC,id ASC"
    ).unwrap();
    for item in items {
        item.comments = merge_comments(
            comments
                .query_map(params![item.owner_uin, item.cell_id], |row| {
                    Ok(comment_from_values(
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        );
        item.comment_count = comment_interaction_count(&item.comments);
        item.likes = deduplicate_likes(
            likes
                .query_map(params![item.owner_uin, item.cell_id], |row| {
                    Ok(LikeUser {
                        uin: row.get(0)?,
                        nickname: row.get(1)?,
                        historical: row.get(2)?,
                        liked_at: row.get(3)?,
                    })
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        );
        item.like_count = item.likes.len() as i64;
    }
}

#[test]
#[ignore = "manual performance comparison; no timing assertions"]
fn compare_interaction_query_cost() {
    let mut connection = database();
    // Avoid snapshot-writing cost in a benchmark intended to measure reads.
    let transaction = connection.transaction().unwrap();
    for index in 0..1000 {
        let cell = format!("post-{index}");
        save_original_dynamic(&transaction, "123", &feed("original", &cell, 311, 100)).unwrap();
        for event in 0..20 {
            transaction.execute(
                "INSERT INTO archive_feeds(owner_uin,feed_key,cell_id,event_type,event_time,actor_uin,actor_name,event_summary,raw_json,archived_at)
                 VALUES ('123',?1,?2,?3,?4,?5,'朋友','评论正文','{}',100)",
                params![format!("{index}-{event}"),cell,if event%2==0 {2} else {217},event,format!("friend-{event}")],
            ).unwrap();
        }
    }
    transaction.commit().unwrap();
    let mut items = archive_items_for_export(&connection, "123", "self", None).unwrap();
    let expected = serde_json::to_value(&items).unwrap();
    let mut baseline = Vec::new();
    let mut batched = Vec::new();
    for _ in 0..7 {
        let started = std::time::Instant::now();
        hydrate_one_at_a_time(&connection, &mut items);
        baseline.push(started.elapsed());
        assert_eq!(serde_json::to_value(&items).unwrap(), expected);
        let started = std::time::Instant::now();
        hydrate_archive_item_interactions(&connection, &mut items).unwrap();
        batched.push(started.elapsed());
        assert_eq!(serde_json::to_value(&items).unwrap(), expected);
    }
    baseline.sort();
    batched.sort();
    eprintln!("1000 posts / 20000 interactions, 7 rounds: baseline median {:?}, batch median {:?}; SQL executions 2000 -> 5",
        baseline[3],batched[3]);
}
