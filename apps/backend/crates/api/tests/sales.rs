//! E4 sales, void and manual-line review against real Postgres and Redis.
mod common;
use axum::http::StatusCode;
use common::world::{World, now_iso, sale_body};
use serde_json::json;
use uuid::Uuid;

const IGNORE: &str = "requires DATABASE_URL and REDIS_URL";

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn create_replay_conflict_and_events() {
    let w = World::new().await;
    let coca = w.product("Coca 330ml", 9000, Some(7000)).await;
    let id = Uuid::now_v7();
    let mut body = sale_body(id, &now_iso(), "cash", &[(coca, 2, 9000)]);
    body["cash_received"] = json!(20000);
    body["vietqr_memo"] = json!("TH 7KQ4MZ");
    let sale = w
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            body.clone(),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(sale["total"], 18000);
    assert_eq!(sale["change_given"], 2000);
    assert_eq!(sale["member_id"], w.seller_id.to_string());
    assert_eq!(sale["code"].as_str().unwrap().len(), 6);
    assert_eq!(sale["status"], "completed");
    assert_eq!(sale["lines"][0]["line_total"], 18000);
    assert_eq!(sale["lines"][0]["price_mismatch"], false);
    assert_eq!(sale["lines"][0]["product_name"], "Coca 330ml");
    // identical replay: 200, no second event
    let again = w
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            body.clone(),
            StatusCode::OK,
        )
        .await;
    assert_eq!(again["code"], sale["code"]);
    assert_eq!(w.events("sale.created").await, 1);
    // same id, different body
    let mut changed = body.clone();
    changed["cash_received"] = json!(30000);
    let r = w.call("POST", "/v1/sales", &w.seller, changed).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["code"], "id_conflict");
    let ev: serde_json::Value = sqlx::query_scalar(
        "SELECT payload->'data' FROM outbox_events WHERE store_id=$1 AND type='sale.created'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(ev["sale_id"], id.to_string());
    assert_eq!(ev["line_count"], 1);
    assert_eq!(ev["total"], 18000);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn business_date_is_ho_chi_minh() {
    let w = World::new().await;
    let p = w.product("Mì", 5000, None).await;
    // 23:30 local on 2026-03-05 is 16:30Z the same day; 00:10 local on 03-06 is 17:10Z on 03-05.
    for (at, date) in [
        ("2026-03-05T23:30:00+07:00", "2026-03-05"),
        ("2026-03-05T17:10:00Z", "2026-03-06"),
    ] {
        let s = w
            .checked(
                "POST",
                "/v1/sales",
                "/v1/sales",
                &w.seller,
                sale_body(Uuid::now_v7(), at, "transfer", &[(p, 1, 5000)]),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(s["business_date"], date);
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn validation_errors() {
    let w = World::new().await;
    let p = w.product("Nước", 5000, None).await;
    let other = World::new().await;
    let foreign = other.product("Lạ", 1000, None).await;
    let ok = || sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(p, 1, 5000)]);
    let mut cases: Vec<(&str, serde_json::Value, StatusCode, &str)> = Vec::new();
    let mut b = ok();
    b["total"] = json!(4999);
    cases.push((
        "total mismatch",
        b,
        StatusCode::BAD_REQUEST,
        "total_mismatch",
    ));
    let mut b = ok();
    b["lines"] = json!([]);
    cases.push(("no lines", b, StatusCode::BAD_REQUEST, "validation_failed"));
    let mut b = ok();
    b["lines"][0]["quantity"] = json!(0);
    cases.push(("qty 0", b, StatusCode::BAD_REQUEST, "validation_failed"));
    let mut b = ok();
    b["lines"][0]["quantity"] = json!(1000);
    b["total"] = json!(5_000_000);
    cases.push(("qty 1000", b, StatusCode::BAD_REQUEST, "validation_failed"));
    let mut b = ok();
    b["lines"][0]["product_id"] = json!(null);
    cases.push((
        "null product, non-manual",
        b,
        StatusCode::BAD_REQUEST,
        "validation_failed",
    ));
    let mut b = ok();
    b["cash_received"] = json!(4000);
    cases.push((
        "cash short",
        b,
        StatusCode::BAD_REQUEST,
        "validation_failed",
    ));
    let mut b = sale_body(Uuid::now_v7(), &now_iso(), "transfer", &[(p, 1, 5000)]);
    b["cash_received"] = json!(5000);
    cases.push((
        "cash on transfer",
        b,
        StatusCode::BAD_REQUEST,
        "validation_failed",
    ));
    let mut b = ok();
    b["payment_method"] = json!("card");
    cases.push((
        "bad method",
        b,
        StatusCode::BAD_REQUEST,
        "validation_failed",
    ));
    cases.push((
        "foreign product",
        sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(foreign, 1, 1000)]),
        StatusCode::NOT_FOUND,
        "not_found",
    ));
    for (name, body, status, code) in cases {
        let r = w.call("POST", "/v1/sales", &w.seller, body).await;
        assert_eq!(r.status, status, "{name}: {}", r.body);
        assert_eq!(r.body["code"], code, "{name}");
    }
    assert_eq!(
        w.call("POST", "/v1/sales", "bad", ok()).await.status,
        StatusCode::UNAUTHORIZED
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM sales WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(n, 0, "rejected sales leave no rows");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn manual_and_mismatch_lines_flow_into_review() {
    let w = World::new().await;
    let coca = w.product("Coca", 9000, None).await;
    let id = Uuid::now_v7();
    let manual_line = Uuid::now_v7();
    let body = json!({
        "id": id, "sold_at": now_iso(), "payment_method": "cash", "total": 7000 + 8000, "cash_received": 20000,
        "lines": [
            {"id": manual_line, "product_id": null, "source": "manual", "quantity": 1, "unit_price": 7000, "manual_label": "kẹo lạ"},
            {"id": Uuid::now_v7(), "product_id": coca, "source": "camera", "quantity": 1, "unit_price": 8000, "suggested_product_id": coca},
        ],
    });
    let sale = w
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            body,
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(
        sale["total"], 15000,
        "server never reprices the seller's price"
    );
    assert_eq!(sale["lines"][1]["unit_price"], 8000);
    assert_eq!(sale["lines"][1]["price_mismatch"], true);
    assert_eq!(sale["lines"][0]["price_mismatch"], false);
    assert_eq!(w.events("review.line_flagged").await, 2);
    // seller cannot see the queue
    assert_eq!(
        w.call("GET", "/v1/review/manual-lines", &w.seller, json!(null))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let q = w
        .checked(
            "GET",
            "/v1/review/manual-lines",
            "/v1/review/manual-lines",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    let items = q["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let reasons: Vec<_> = items
        .iter()
        .map(|i| i["reason"].as_str().unwrap())
        .collect();
    assert!(reasons.contains(&"manual_price") && reasons.contains(&"price_mismatch"));
    let manual = items
        .iter()
        .find(|i| i["reason"] == "manual_price")
        .unwrap();
    assert_eq!(manual["line_id"], manual_line.to_string());
    assert_eq!(manual["sold_by"], w.seller_id.to_string());
    assert_eq!(manual["status"], "open");
    // resolve: link requires product_id
    let path = format!("/v1/review/manual-lines/{manual_line}/resolve");
    assert_eq!(
        w.call("POST", &path, &w.lead, json!({"action":"link"}))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.call("POST", &path, &w.seller, json!({"action":"dismiss"}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.call(
            "POST",
            &path,
            &w.lead,
            json!({"action":"link","product_id":Uuid::now_v7()})
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let done = w
        .checked(
            "POST",
            &path,
            "/v1/review/manual-lines/{lineId}/resolve",
            &w.lead,
            json!({"action":"link","product_id":coca}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(done["status"], "resolved");
    assert_eq!(done["resolution"]["action"], "link");
    assert_eq!(done["resolution"]["product_id"], coca.to_string());
    assert_eq!(done["resolution"]["resolved_by"], w.lead_id.to_string());
    assert_eq!(
        w.call("POST", &path, &w.lead, json!({"action":"dismiss"}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(w.events("review.line_resolved").await, 1);
    let open = w
        .call("GET", "/v1/review/manual-lines", &w.lead, json!(null))
        .await;
    assert_eq!(open.body["items"].as_array().unwrap().len(), 1);
    let resolved = w
        .call(
            "GET",
            "/v1/review/manual-lines?status=resolved",
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(resolved.body["items"].as_array().unwrap().len(), 1);
    // amounts never change
    let after = w
        .call("GET", &format!("/v1/sales/{id}"), &w.lead, json!(null))
        .await;
    assert_eq!(after.body["total"], 15000);
    // other store sees nothing and gets 404
    let other = World::new().await;
    assert_eq!(
        other
            .call("POST", &path, &other.lead, json!({"action":"dismiss"}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn scans_detections_and_suggestions_link_to_the_sale() {
    let w = World::new().await;
    let p = w.product("Bia", 15000, None).await;
    let (sid, did) = w.scan_fixture().await;
    let id = Uuid::now_v7();
    let mut body = sale_body(id, &now_iso(), "transfer", &[(p, 1, 15000)]);
    body["scan_ids"] = json!([sid]);
    body["lines"][0]["detection_id"] = json!(did);
    body["lines"][0]["suggested_product_id"] = json!(p);
    let sale = w
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &w.seller,
            body,
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(sale["lines"][0]["detection_id"], did.to_string());
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sale_scans WHERE sale_id=$1 AND scan_id=$2")
            .bind(id)
            .bind(sid)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(n, 1);
    // a detection can back only one line
    let mut dup = sale_body(Uuid::now_v7(), &now_iso(), "transfer", &[(p, 1, 15000)]);
    dup["lines"][0]["detection_id"] = json!(did);
    assert_eq!(
        w.call("POST", "/v1/sales", &w.seller, dup).await.status,
        StatusCode::CONFLICT
    );
    // another store's scan is rejected
    let other = World::new().await;
    let q = sale_body(
        Uuid::now_v7(),
        &now_iso(),
        "transfer",
        &[(other.product("X", 1000, None).await, 1, 1000)],
    );
    assert_eq!(
        other
            .call("POST", "/v1/sales", &other.lead, {
                let mut q = q;
                q["scan_ids"] = json!([sid]);
                q
            })
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn list_filters_pagination_and_isolation() {
    let w = World::new().await;
    let p = w.product("Kẹo", 2000, None).await;
    let mut ids = Vec::new();
    for i in 0..5 {
        let id = Uuid::now_v7();
        ids.push(id);
        let method = if i % 2 == 0 { "cash" } else { "transfer" };
        let token = if i < 3 { &w.seller } else { &w.lead };
        let at = format!("2026-04-0{}T10:00:00+07:00", i + 1);
        w.checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            token,
            sale_body(id, &at, method, &[(p, 1, 2000)]),
            StatusCode::CREATED,
        )
        .await;
    }
    let first = w
        .checked(
            "GET",
            "/v1/sales?limit=2",
            "/v1/sales",
            &w.lead,
            json!(null),
            StatusCode::OK,
        )
        .await;
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    assert_eq!(first["items"][0]["id"], ids[4].to_string(), "newest first");
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = w
        .call(
            "GET",
            &format!("/v1/sales?limit=2&cursor={cursor}"),
            &w.lead,
            json!(null),
        )
        .await;
    assert_eq!(second.body["items"][0]["id"], ids[2].to_string());
    let mut seen = 0;
    let mut cur = String::new();
    loop {
        let r = w
            .call(
                "GET",
                &format!("/v1/sales?limit=2{cur}"),
                &w.lead,
                json!(null),
            )
            .await;
        seen += r.body["items"].as_array().unwrap().len();
        match r.body["next_cursor"].as_str() {
            Some(c) => cur = format!("&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(seen, 5);
    let f = |q: String| {
        let w = &w;
        async move {
            w.call("GET", &format!("/v1/sales?{q}"), &w.lead, json!(null))
                .await
                .body["items"]
                .as_array()
                .unwrap()
                .len()
        }
    };
    assert_eq!(f("from=2026-04-02&to=2026-04-03".into()).await, 2);
    assert_eq!(f("payment_method=transfer".into()).await, 2);
    assert_eq!(f(format!("member_id={}", w.seller_id)).await, 3);
    assert_eq!(f("status=voided".into()).await, 0);
    assert_eq!(
        w.call(
            "GET",
            "/v1/sales?limit=2&cursor=%25%25",
            &w.lead,
            json!(null)
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let other = World::new().await;
    assert_eq!(
        other
            .call(
                "GET",
                &format!("/v1/sales/{}", ids[0]),
                &other.lead,
                json!(null)
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        other
            .call("GET", "/v1/sales", &other.lead, json!(null))
            .await
            .body["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn void_authorization_idempotency_and_events() {
    let w = World::new().await;
    let p = w.product("Sữa", 8000, None).await;
    let mine = Uuid::now_v7();
    let theirs = Uuid::now_v7();
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        sale_body(mine, &now_iso(), "cash", &[(p, 1, 8000)]),
        StatusCode::CREATED,
    )
    .await;
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.lead,
        sale_body(theirs, &now_iso(), "cash", &[(p, 1, 8000)]),
        StatusCode::CREATED,
    )
    .await;
    let void = |id: Uuid| format!("/v1/sales/{id}/void");
    assert_eq!(
        w.call("POST", &void(mine), &w.seller, json!({}))
            .await
            .status,
        StatusCode::BAD_REQUEST,
        "reason required"
    );
    assert_eq!(
        w.call("POST", &void(theirs), &w.seller, json!({"reason":"x"}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let v = w
        .checked(
            "POST",
            &void(mine),
            "/v1/sales/{saleId}/void",
            &w.seller,
            json!({"reason":"khách trả hàng"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(v["status"], "voided");
    assert_eq!(v["void"]["reason"], "khách trả hàng");
    assert_eq!(v["void"]["voided_by"], w.seller_id.to_string());
    let again = w
        .checked(
            "POST",
            &void(mine),
            "/v1/sales/{saleId}/void",
            &w.seller,
            json!({"reason":"khách trả hàng"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(again["void"]["voided_at"], v["void"]["voided_at"]);
    assert_eq!(w.events("sale.voided").await, 1);
    w.checked(
        "POST",
        &void(theirs),
        "/v1/sales/{saleId}/void",
        &w.lead,
        json!({"reason":"nhầm"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(w.events("sale.voided").await, 2);
    let voided = w
        .call("GET", "/v1/sales?status=voided", &w.lead, json!(null))
        .await;
    assert_eq!(voided.body["items"].as_array().unwrap().len(), 2);
    // seller cannot void an earlier business date, Lead can
    let old = Uuid::now_v7();
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        sale_body(old, "2026-01-02T10:00:00+07:00", "cash", &[(p, 1, 8000)]),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        w.call("POST", &void(old), &w.seller, json!({"reason":"x"}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.call("POST", &void(old), &w.lead, json!({"reason":"x"}))
            .await
            .status,
        StatusCode::OK
    );
    let other = World::new().await;
    assert_eq!(
        other
            .call("POST", &void(old), &other.lead, json!({"reason":"x"}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let _ = IGNORE;
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn concurrent_identical_creates_store_one_sale() {
    let w = World::new().await;
    let p = w.product("Trà", 6000, None).await;
    let body = sale_body(Uuid::now_v7(), &now_iso(), "cash", &[(p, 1, 6000)]);
    let (a, b) = tokio::join!(
        w.call("POST", "/v1/sales", &w.seller, body.clone()),
        w.call("POST", "/v1/sales", &w.seller, body.clone())
    );
    let mut s = [a.status.as_u16(), b.status.as_u16()];
    s.sort();
    assert_eq!(s, [200, 201]);
    assert_eq!(w.events("sale.created").await, 1);
}

/// #176: a client cannot pick the day of a sale or a void.
#[tokio::test]
#[ignore = "requires DATABASE_URL and REDIS_URL"]
async fn sold_at_is_bounded_and_void_time_is_server_set() {
    use chrono::{DateTime, Duration, Utc};
    let w = World::new().await;
    let p = w.product("Kẹo", 1000, None).await;
    // Production defaults: 72 hour offline window, 5 minute future skew.
    let mut state = w.state.clone();
    state.sale_window = taphoa_api::time::SaleWindow::default();
    let app = taphoa_api::router(state);
    let post = |token: &str, at: String| {
        let body = sale_body(Uuid::now_v7(), &at, "cash", &[(p, 1, 1000)]);
        let app = app.clone();
        let token = token.to_owned();
        async move { common::world::send(&app, "POST", "/v1/sales", Some(&token), body).await }
    };
    let ago = |d: Duration| (Utc::now() - d).to_rfc3339();
    let ahead = |d: Duration| (Utc::now() + d).to_rfc3339();
    let booked = |r: &common::world::Reply| -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(r.body["sold_at"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc)
    };
    // Outside the window the sale is still recorded, but at server time: no day can be chosen.
    for (name, at) in [
        ("back-dated a year", ago(Duration::days(365))),
        ("just past the offline window", ago(Duration::hours(73))),
        ("far future", ahead(Duration::days(30))),
        ("beyond the skew", ahead(Duration::minutes(30))),
    ] {
        let r = post(&w.seller, at).await;
        assert_eq!(r.status, StatusCode::CREATED, "{name}: {}", r.body);
        assert!(
            (Utc::now() - booked(&r)).num_seconds().abs() < 120,
            "{name}"
        );
        assert_eq!(
            r.body["business_date"],
            taphoa_api::time::business_date(Utc::now()).to_string(),
            "{name}"
        );
    }
    // Offline queue: a day old, and a phone clock a minute fast, keep their own time.
    let day_old = ago(Duration::hours(24));
    let r = post(&w.seller, day_old.clone()).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(
        booked(&r).timestamp_micros(),
        day_old.parse::<DateTime<Utc>>().unwrap().timestamp_micros()
    );
    let fast = ahead(Duration::minutes(1));
    let r = post(&w.seller, fast.clone()).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(
        booked(&r).timestamp_micros(),
        fast.parse::<DateTime<Utc>>().unwrap().timestamp_micros()
    );

    // Void: the client voided_at is ignored.
    let id = Uuid::now_v7();
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        sale_body(id, &now_iso(), "cash", &[(p, 1, 1000)]),
        StatusCode::CREATED,
    )
    .await;
    let voided = w
        .call(
            "POST",
            &format!("/v1/sales/{id}/void"),
            &w.lead,
            json!({"reason": "test", "voided_at": "2020-01-01T00:00:00Z"}),
        )
        .await;
    assert_eq!(voided.status, StatusCode::OK, "{}", voided.body);
    let at =
        DateTime::parse_from_rfc3339(voided.body["void"]["voided_at"].as_str().unwrap()).unwrap();
    assert!(
        (Utc::now() - at.with_timezone(&Utc)).num_seconds().abs() < 120,
        "voided_at {at}"
    );

    // Closed days. Yesterday is closed: a seller's offline sale from yesterday lands today so the
    // closed figures stay put, while the Lead keeps the date they entered.
    let yesterday = Utc::now() - Duration::hours(24);
    let day = taphoa_api::time::business_date(yesterday);
    let closed = w
        .call(
            "PUT",
            &format!("/v1/day-closes/{day}"),
            &w.lead,
            json!({"counted_cash": 0}),
        )
        .await;
    assert_eq!(closed.status, StatusCode::OK, "{}", closed.body);
    let seller = post(&w.seller, yesterday.to_rfc3339()).await;
    assert_eq!(seller.status, StatusCode::CREATED, "{}", seller.body);
    assert_eq!(
        seller.body["business_date"],
        taphoa_api::time::business_date(Utc::now()).to_string()
    );
    let lead = post(&w.lead, yesterday.to_rfc3339()).await;
    assert_eq!(lead.body["business_date"], day.to_string());
    // Closing today early does not stop the shop selling: that is a normal sale.
    let today = taphoa_api::time::business_date(Utc::now());
    let close_today = w
        .call(
            "PUT",
            &format!("/v1/day-closes/{today}"),
            &w.lead,
            json!({"counted_cash": 0}),
        )
        .await;
    assert_eq!(close_today.status, StatusCode::OK);
    let after = post(&w.seller, now_iso()).await;
    assert_eq!(after.status, StatusCode::CREATED, "{}", after.body);
    assert_eq!(after.body["business_date"], today.to_string());
}
