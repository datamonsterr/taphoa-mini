//! X3 assistant threads, message listing and feedback against real Postgres and Redis.
mod common;
use axum::http::StatusCode;
use common::{
    Contract,
    world::{Reply, World, send},
};
use serde_json::{Value, json};
use uuid::Uuid;

const THREADS: &str = "/v1/assistant/threads";
const THREAD: &str = "/v1/assistant/threads/{threadId}";
const FEEDBACK: &str = "/v1/assistant/messages/{messageId}/feedback";

async fn create(w: &World, token: &str, body: Value) -> Value {
    w.checked("POST", THREADS, THREADS, token, body, StatusCode::CREATED)
        .await
}
fn id_of(value: &Value) -> Uuid {
    value["id"].as_str().unwrap().parse().unwrap()
}
/// Insert a message row directly; the message endpoint belongs to the agent loop.
async fn message(w: &World, thread: Uuid, role: &str, content: &str, offset_secs: i32) -> Uuid {
    sqlx::query_scalar("INSERT INTO assistant_messages (id,thread_id,store_id,role,content,tool_calls,cards,model,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9)) RETURNING id")
        .bind(Uuid::now_v7())
        .bind(thread)
        .bind(w.store_id)
        .bind(role)
        .bind(content)
        .bind(json!([{"call_id":"call_1","tool":"get_restock_plan","ok":true,"summary_vi":"Có 1 mặt hàng sắp hết"}]))
        .bind(json!([{"type":"restock_list","items":[{"product_id":Uuid::nil(),"name":"Coca lon","quantity":24,"unit_cost":8500,"total_cost":204000}],"total_cost":204000}]))
        .bind((role == "assistant").then_some("provider/model"))
        .bind(f64::from(offset_secs))
        .fetch_one(w.pool())
        .await
        .unwrap()
}
async fn expect(
    w: &World,
    method: &str,
    path: &str,
    template: &str,
    token: &str,
    body: Value,
    status: StatusCode,
) -> Value {
    let reply = w.call(method, path, token, body).await;
    assert_eq!(reply.status, status, "{method} {path}: {}", reply.body);
    if !reply.body.is_null() {
        Contract::load().assert_conforms(template, &method.to_lowercase(), status, &reply.body);
    }
    reply.body
}
fn code(reply: &Value) -> &str {
    reply["code"].as_str().unwrap()
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn create_get_and_delete_thread() {
    let w = World::new().await;
    let receipt = Uuid::now_v7();
    let thread = create(
        &w,
        &w.lead,
        json!({"title":"Nhập hàng","context":{"screen":"camera","next_step_id":"restock","receipt_id":receipt}}),
    )
    .await;
    assert_eq!(thread["title"], "Nhập hàng");
    assert_eq!(thread["context"]["screen"], "camera");
    assert_eq!(thread["context"]["receipt_id"], receipt.to_string());
    // Optional fields stay out of the stored context.
    assert!(thread["context"].get("image_id").is_none());
    let bare = create(&w, &w.seller, json!({})).await;
    assert!(bare["title"].is_null() && bare["context"].is_null());

    let path = format!("/v1/assistant/threads/{}", thread["id"].as_str().unwrap());
    let detail = w
        .checked("GET", &path, THREAD, &w.lead, Value::Null, StatusCode::OK)
        .await;
    assert_eq!(detail["thread"], thread);
    assert_eq!(detail["messages"], json!([]));
    assert_eq!(detail["actions"], json!([]));

    let thread_id = id_of(&thread);
    let user = message(&w, thread_id, "user", "Hôm qua bán mấy chai Coca?", -2).await;
    message(&w, thread_id, "assistant", "Bán được 24 chai.", -1).await;
    let status = w.call("DELETE", &path, &w.lead, Value::Null).await;
    assert_eq!(status.status, StatusCode::NO_CONTENT);
    assert!(status.raw.is_empty());
    expect(
        &w,
        "GET",
        &path,
        THREAD,
        &w.lead,
        Value::Null,
        StatusCode::NOT_FOUND,
    )
    .await;
    // Messages go with the thread; the bare thread is untouched.
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM assistant_messages WHERE id=$1")
        .bind(user)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(left, 0);
    let seller_path = format!("/v1/assistant/threads/{}", bare["id"].as_str().unwrap());
    w.checked(
        "GET",
        &seller_path,
        THREAD,
        &w.seller,
        Value::Null,
        StatusCode::OK,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn invalid_thread_input_is_rejected() {
    let w = World::new().await;
    for bad in [
        json!({"title":""}),
        json!({"title":"   "}),
        json!({"title":"x".repeat(201)}),
        json!({"title":7}),
        json!({"context":{}}),
        json!({"context":{"screen":""}}),
        json!({"context":{"screen":"camera","receipt_id":"nope"}}),
        json!({"context":{"screen":"camera","extra":1}}),
        json!({"unknown":true}),
    ] {
        let body = expect(
            &w,
            "POST",
            THREADS,
            THREADS,
            &w.lead,
            bad.clone(),
            StatusCode::BAD_REQUEST,
        )
        .await;
        assert_eq!(code(&body), "validation_failed", "{bad}");
    }
    let unauthenticated = send(&w.app, "GET", THREADS, None, Value::Null).await;
    assert_eq!(unauthenticated.status, StatusCode::UNAUTHORIZED);
    let unauthenticated = send(&w.app, "POST", THREADS, None, json!({})).await;
    assert_eq!(unauthenticated.status, StatusCode::UNAUTHORIZED);
    for (method, path) in [
        ("GET", "/v1/assistant/threads/not-a-uuid"),
        ("DELETE", "/v1/assistant/threads/not-a-uuid"),
        ("POST", "/v1/assistant/messages/not-a-uuid/feedback"),
    ] {
        let body = if method == "POST" {
            json!({"rating":"up"})
        } else {
            Value::Null
        };
        let reply = w.call(method, path, &w.lead, body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{method} {path}");
        assert_eq!(code(&reply.body), "validation_failed");
    }
    let missing = format!("/v1/assistant/threads/{}", Uuid::now_v7());
    for method in ["GET", "DELETE"] {
        let reply = w.call(method, &missing, &w.lead, Value::Null).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{method}");
        assert_eq!(code(&reply.body), "not_found");
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn list_is_newest_first_with_cursor_pagination() {
    let w = World::new().await;
    let mut created = Vec::new();
    for title in ["Một", "Hai", "Ba"] {
        created.push(create(&w, &w.lead, json!({"title":title})).await);
    }
    create(&w, &w.seller, json!({"title":"Của người bán"})).await;

    let page = w
        .checked(
            "GET",
            &format!("{THREADS}?limit=2"),
            THREADS,
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    let titles = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(titles(&page), ["Ba", "Hai"]);
    let cursor = page["next_cursor"].as_str().unwrap();
    let rest = w
        .checked(
            "GET",
            &format!("{THREADS}?limit=2&cursor={cursor}"),
            THREADS,
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(titles(&rest), ["Một"]);
    assert!(rest["next_cursor"].is_null());

    // Activity moves a thread to the top: ordering follows updated_at.
    sqlx::query("UPDATE assistant_threads SET updated_at=now()+interval '1 minute' WHERE id=$1")
        .bind(id_of(&created[0]))
        .execute(w.pool())
        .await
        .unwrap();
    let page = w
        .checked(
            "GET",
            THREADS,
            THREADS,
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(titles(&page), ["Một", "Ba", "Hai"]);
    let seller = w
        .checked(
            "GET",
            THREADS,
            THREADS,
            &w.seller,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(titles(&seller), ["Của người bán"]);
    let bad = w
        .call(
            "GET",
            &format!("{THREADS}?cursor=%25%25"),
            &w.lead,
            Value::Null,
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&bad.body), "invalid_cursor");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn threads_are_private_to_their_member_and_store() {
    let w = World::new().await;
    let other_store = World::new().await;
    let thread = create(&w, &w.lead, json!({"title":"Riêng tư"})).await;
    let thread_id = id_of(&thread);
    let reply_message = message(&w, thread_id, "assistant", "Xin chào", 0).await;
    let path = format!("/v1/assistant/threads/{thread_id}");
    let feedback = format!("/v1/assistant/messages/{reply_message}/feedback");
    // Another member of the same store and a member of another store both get 404, never 403.
    for token in [&w.seller, &other_store.lead] {
        for (method, route, template, body) in [
            ("GET", &path, THREAD, Value::Null),
            ("DELETE", &path, THREAD, Value::Null),
            ("POST", &feedback, FEEDBACK, json!({"rating":"up"})),
        ] {
            let body = expect(
                &w,
                method,
                route,
                template,
                token,
                body,
                StatusCode::NOT_FOUND,
            )
            .await;
            assert_eq!(code(&body), "not_found");
        }
    }
    let list = w
        .checked(
            "GET",
            THREADS,
            THREADS,
            &other_store.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    assert_eq!(list["items"], json!([]));
    // The rejected calls changed nothing.
    let still: i64 = sqlx::query_scalar("SELECT count(*) FROM assistant_threads WHERE id=$1")
        .bind(thread_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    let feedback_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM assistant_feedback WHERE message_id=$1")
            .bind(reply_message)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!((still, feedback_rows), (1, 0));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn detail_lists_messages_oldest_first_with_cards_and_own_feedback() {
    let w = World::new().await;
    let thread = create(&w, &w.lead, json!({"title":"Chi tiết"})).await;
    let thread_id = id_of(&thread);
    // Inserted newest first on purpose: the response orders by created_at.
    let answer = message(&w, thread_id, "assistant", "Cần nhập thêm Coca.", -1).await;
    let question = message(&w, thread_id, "user", "Nhập gì?", -2).await;
    let path = format!("/v1/assistant/threads/{thread_id}");
    let detail = w
        .checked("GET", &path, THREAD, &w.lead, Value::Null, StatusCode::OK)
        .await;
    let messages = detail["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], question.to_string());
    assert_eq!(messages[1]["id"], answer.to_string());
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["attachments"], json!([]));
    assert!(messages[0]["model"].is_null());
    assert_eq!(messages[1]["model"], "provider/model");
    assert_eq!(messages[1]["tool_calls"][0]["tool"], "get_restock_plan");
    assert_eq!(messages[1]["cards"][0]["type"], "restock_list");
    assert!(messages.iter().all(|m| m["feedback"].is_null()));

    let feedback = format!("/v1/assistant/messages/{answer}/feedback");
    let reply = w
        .call("POST", &feedback, &w.lead, json!({"rating":"up"}))
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(reply.raw.is_empty());
    let detail = w
        .checked("GET", &path, THREAD, &w.lead, Value::Null, StatusCode::OK)
        .await;
    assert_eq!(detail["messages"][1]["feedback"], json!({"rating":"up"}));
    assert!(detail["messages"][0]["feedback"].is_null());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn detail_lists_actions_in_contract_shape() {
    let w = World::new().await;
    let thread = create(&w, &w.lead, json!({})).await;
    let thread_id = id_of(&thread);
    let answer = message(&w, thread_id, "assistant", "Đã soạn đề xuất.", 0).await;
    let insert = |kind: &'static str, status: &'static str, offset: i32| {
        let w = &w;
        async move {
            sqlx::query_scalar::<_, Uuid>("INSERT INTO assistant_actions (id,store_id,thread_id,message_id,kind,payload,summary_vi,status,proposed_by,decided_by,decided_at,result,error,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '24 hours',now()+make_interval(secs=>$14)) RETURNING id")
                .bind(Uuid::now_v7())
                .bind(w.store_id)
                .bind(thread_id)
                .bind(answer)
                .bind(kind)
                .bind(json!({"amount":150000,"category":"dien","note":"Tiền điện","paid_with":"cash_box"}))
                .bind("Ghi chi phí điện 150.000 ₫")
                .bind(status)
                .bind(w.lead_id)
                .bind((status != "proposed").then_some(w.lead_id))
                .bind((status != "proposed").then(chrono::Utc::now))
                .bind((status == "done").then(|| json!({"expense_id":Uuid::nil()})))
                .bind((status == "failed").then(|| json!({"code":"forbidden","message":"permission denied"})))
                .bind(f64::from(offset))
                .fetch_one(w.pool())
                .await
                .unwrap()
        }
    };
    let proposed = insert("expense", "proposed", 0).await;
    let done = insert("expense", "done", 1).await;
    let failed = insert("expense", "failed", 2).await;
    let detail = w
        .checked(
            "GET",
            &format!("/v1/assistant/threads/{thread_id}"),
            THREAD,
            &w.lead,
            Value::Null,
            StatusCode::OK,
        )
        .await;
    let actions = detail["actions"].as_array().unwrap();
    assert_eq!(
        actions.iter().map(|a| a["id"].clone()).collect::<Vec<_>>(),
        [proposed, done, failed].map(|id| json!(id.to_string()))
    );
    let [proposed, done, failed] = [&actions[0], &actions[1], &actions[2]];
    assert_eq!(proposed["status"], "proposed");
    assert!(proposed["decided_by"].is_null() && proposed["result"].is_null());
    assert_eq!(proposed["proposed_by"], w.lead_id.to_string());
    assert_eq!(proposed["message_id"], answer.to_string());
    assert_eq!(done["result"]["expense_id"], Uuid::nil().to_string());
    assert!(done["error"].is_null());
    assert_eq!(failed["error"]["code"], "forbidden");
    // Server-only columns never reach the client.
    for action in actions {
        assert!(action.get("idempotency_key_hash").is_none());
        assert!(action.get("trace_id").is_none());
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn feedback_upserts_per_member_and_rejects_user_messages() {
    let w = World::new().await;
    let thread = create(&w, &w.lead, json!({})).await;
    let thread_id = id_of(&thread);
    let user = message(&w, thread_id, "user", "Xin chào", -2).await;
    let answer = message(&w, thread_id, "assistant", "Chào bạn", -1).await;
    let feedback = format!("/v1/assistant/messages/{answer}/feedback");
    let path = format!("/v1/assistant/threads/{thread_id}");
    let stored = || async {
        sqlx::query_as::<_, (String, Option<String>, Uuid)>(
            "SELECT rating,comment,store_id FROM assistant_feedback WHERE message_id=$1 AND member_id=$2",
        )
        .bind(answer)
        .bind(w.lead_id)
        .fetch_all(w.pool())
        .await
        .unwrap()
    };

    for (body, rating, comment) in [
        (json!({"rating":"up"}), "up", None),
        (
            json!({"rating":"down","comment":"Chưa đúng"}),
            "down",
            Some("Chưa đúng"),
        ),
        // A repeat without comment replaces the earlier comment.
        (json!({"rating":"up"}), "up", None),
        (
            json!({"rating":"down","comment":"  Chưa đúng  "}),
            "down",
            Some("Chưa đúng"),
        ),
        // A blank comment counts as none.
        (json!({"rating":"up","comment":"   "}), "up", None),
    ] {
        let reply: Reply = w.call("POST", &feedback, &w.lead, body).await;
        assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
        let rows = stored().await;
        assert_eq!(rows.len(), 1, "one row per message and member");
        assert_eq!(
            (rows[0].0.as_str(), rows[0].1.as_deref(), rows[0].2),
            (rating, comment, w.store_id)
        );
    }
    let reply = w
        .call(
            "POST",
            &feedback,
            &w.lead,
            json!({"rating":"down","comment":"Sai số liệu"}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let detail = w
        .checked("GET", &path, THREAD, &w.lead, Value::Null, StatusCode::OK)
        .await;
    assert_eq!(
        detail["messages"][1]["feedback"],
        json!({"rating":"down","comment":"Sai số liệu"})
    );

    // Feedback targets assistant messages only.
    let on_user = expect(
        &w,
        "POST",
        &format!("/v1/assistant/messages/{user}/feedback"),
        FEEDBACK,
        &w.lead,
        json!({"rating":"up"}),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(code(&on_user), "validation_failed");
    let missing = format!("/v1/assistant/messages/{}/feedback", Uuid::now_v7());
    let body = expect(
        &w,
        "POST",
        &missing,
        FEEDBACK,
        &w.lead,
        json!({"rating":"up"}),
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_eq!(code(&body), "not_found");
    for bad in [
        json!({}),
        json!({"rating":"neutral"}),
        json!({"rating":"up","extra":1}),
        json!({"rating":"up","comment":7}),
        json!({"rating":"up","comment":"x".repeat(1001)}),
    ] {
        let body = expect(
            &w,
            "POST",
            &feedback,
            FEEDBACK,
            &w.lead,
            bad.clone(),
            StatusCode::BAD_REQUEST,
        )
        .await;
        assert_eq!(code(&body), "validation_failed", "{bad}");
    }
    // Deleting the thread removes its feedback.
    let reply = w.call("DELETE", &path, &w.lead, Value::Null).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(stored().await.is_empty());
}
