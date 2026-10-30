mod common;
use axum::http::StatusCode;
use common::{
    Contract,
    voice::{line, sale, setup, upload, upload_with},
    world::{World, now_iso},
};
use serde_json::{Value, json};
use taphoa_api::voice::{
    audio::fixtures,
    model::{Intent, VoiceParse},
    scripted::{Call, Step},
};
use uuid::Uuid;

const PATH: &str = "/v1/voice/utterances";

fn clip() -> Vec<u8> {
    fixtures::m4a(3.0, b"fake-aac-bytes")
}
fn ok(w: &World, status: StatusCode, body: &Value) {
    Contract::load().assert_conforms(PATH, "post", status, body);
    let _ = w;
}
async fn customer(w: &World, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO customers(id,store_id,name,request_hash) VALUES($1,$2,$3,'\\x00')")
        .bind(id)
        .bind(w.store_id)
        .bind(name)
        .execute(w.pool())
        .await
        .unwrap();
    id
}
async fn outcome(w: &World, id: &str, body: Value) -> StatusCode {
    w.call("POST", &format!("{PATH}/{id}/outcome"), &w.seller, body)
        .await
        .status
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn two_line_sale_matches_prices_and_stores_the_row() {
    let parse = sale(
        "một chai tương ớt hai mươi nghìn với hai gói hảo hảo",
        vec![
            line(
                "chai tương ớt",
                "tương ớt",
                Some(1.0),
                Some("chai"),
                Some(20000.0),
                Some("hai mươi nghìn"),
            ),
            line(
                "hai gói hảo hảo",
                "hảo hảo",
                Some(2.0),
                Some("gói"),
                None,
                None,
            ),
        ],
        "cash",
        None,
    );
    let (w, model) = setup(vec![Step::parse(parse)], |_| {}).await;
    let chili = w.product("Tương ớt Chinsu", 18000, None).await;
    let noodles = w.product("Mì Hảo Hảo", 4500, None).await;
    let audio = clip();
    let r = upload(&w, &audio, "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    ok(&w, r.status, &r.body);
    let lines = r.body["sale_draft"]["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["status"], "matched");
    assert_eq!(lines[0]["product"]["id"], json!(chili));
    assert_eq!(lines[0]["unit_price"], 20000);
    assert_eq!(lines[0]["price_source"], "spoken");
    assert_eq!(lines[0]["price_mismatch"], true);
    assert_eq!(lines[1]["product"]["id"], json!(noodles));
    assert_eq!(lines[1]["quantity"], 2);
    assert_eq!(lines[1]["unit_price"], 4500);
    assert_eq!(lines[1]["price_source"], "catalog");
    assert_eq!(r.body["sale_draft"]["total"], 20000 + 9000);
    assert_eq!(r.body["sale_draft"]["payment_method"], "cash");
    assert_eq!(r.body["model"], "g/one");
    assert_eq!(r.body["stt_fallback"], false);
    // The model received the exact bytes and the catalog hint; nothing else keeps the audio.
    match &model.calls()[0] {
        Call::Audio {
            audio: sent,
            format,
            hint,
            ..
        } => {
            assert_eq!(sent, &audio);
            assert_eq!(*format, "m4a");
            assert!(hint.contains("Tương ớt Chinsu") && hint.contains("Mì Hảo Hảo"));
        }
        other => panic!("{other:?}"),
    }
    let (transcript, model_name, draft): (String, String, Option<Value>) =
        sqlx::query_as("SELECT transcript, model, draft FROM voice_utterances WHERE id=$1")
            .bind(r.body["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert!(transcript.starts_with("một chai"));
    assert_eq!(model_name, "g/one");
    assert!(draft.is_some());
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn unknown_product_becomes_a_manual_line_and_missing_price_needs_one() {
    let parse = sale(
        "một bao gạo ba mươi lăm nghìn và hai cái bia tiger",
        vec![
            line(
                "bao gạo",
                "gạo ST25",
                Some(1.0),
                Some("bao"),
                Some(35000.0),
                Some("ba mươi lăm nghìn"),
            ),
            line(
                "hai cái bia tiger",
                "bia tiger",
                Some(2.0),
                None,
                None,
                None,
            ),
        ],
        "cash",
        None,
    );
    let (w, _) = setup(vec![Step::parse(parse)], |_| {}).await;
    w.product("Coca Cola lon", 10000, None).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    ok(&w, r.status, &r.body);
    let lines = r.body["sale_draft"]["lines"].as_array().unwrap();
    assert_eq!(lines[0]["status"], "unknown");
    assert!(lines[0].get("product").is_none());
    assert_eq!(lines[0]["unit_price"], 35000);
    assert_eq!(lines[0]["price_source"], "spoken");
    assert_eq!(lines[0]["spoken"], "gạo");
    assert_eq!(lines[1]["status"], "unknown");
    assert_eq!(lines[1]["needs_price"], true);
    assert!(lines[1]["unit_price"].is_null());
    assert_eq!(r.body["sale_draft"]["total"], 35000);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ambiguous_lines_carry_up_to_three_candidates() {
    let parse = sale(
        "ba chai nước mắm",
        vec![line(
            "ba chai nước mắm",
            "nước mắm",
            Some(3.0),
            Some("chai"),
            None,
            None,
        )],
        "cash",
        None,
    );
    let (w, _) = setup(vec![Step::parse(parse)], |_| {}).await;
    w.product("Nước mắm Nam Ngư", 32000, None).await;
    w.product("Nước mắm Chinsu", 30000, None).await;
    w.product("Nước mắm Phú Quốc", 45000, None).await;
    w.product("Nước mắm Hạ Long", 28000, None).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    ok(&w, r.status, &r.body);
    let l = &r.body["sale_draft"]["lines"][0];
    assert_eq!(l["status"], "ambiguous");
    let candidates = l["candidates"].as_array().unwrap();
    assert!((2..=3).contains(&candidates.len()));
    assert_eq!(l["product"]["id"], candidates[0]["id"]);
    assert_eq!(l["unit_price"], l["product"]["price"]);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn credit_sale_matches_the_customer() {
    let credit = |name: Option<&str>| {
        sale(
            "hai chai nước mắm ghi nợ",
            vec![line(
                "hai chai nước mắm",
                "nước mắm",
                Some(2.0),
                None,
                None,
                None,
            )],
            "credit",
            name,
        )
    };
    let (w, _) = setup(
        vec![
            Step::parse(credit(Some("chị Lan"))),
            Step::parse(credit(Some("Hoa"))),
            Step::parse(credit(Some("Minh"))),
            Step::parse(credit(None)),
        ],
        |_| {},
    )
    .await;
    w.product("Nước mắm Nam Ngư", 32000, None).await;
    let lan = customer(&w, "Chị Lan").await;
    customer(&w, "Minh Anh").await;
    customer(&w, "Minh Tâm").await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    ok(&w, r.status, &r.body);
    let c = &r.body["sale_draft"]["customer"];
    assert_eq!(r.body["sale_draft"]["payment_method"], "credit");
    assert_eq!(c["status"], "matched");
    assert_eq!(c["customer"]["id"], json!(lan));
    let none = upload(&w, &clip(), "sale").await;
    ok(&w, none.status, &none.body);
    assert_eq!(none.body["sale_draft"]["customer"]["status"], "none");
    assert_eq!(none.body["sale_draft"]["customer"]["spoken_name"], "Hoa");
    let many = upload(&w, &clip(), "sale").await;
    ok(&w, many.status, &many.body);
    assert_eq!(many.body["sale_draft"]["customer"]["status"], "candidates");
    assert_eq!(
        many.body["sale_draft"]["customer"]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let unnamed = upload(&w, &clip(), "sale").await;
    ok(&w, unnamed.status, &unnamed.body);
    assert_eq!(unnamed.body["sale_draft"]["customer"]["status"], "none");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn nothing_heard_is_422_no_speech() {
    let silent = VoiceParse {
        intent: Intent::None,
        ..VoiceParse::default()
    };
    let empty = VoiceParse {
        intent: Intent::Sale,
        transcript: "  ".into(),
        ..VoiceParse::default()
    };
    let (w, _) = setup(vec![Step::parse(silent), Step::parse(empty)], |_| {}).await;
    for _ in 0..2 {
        let r = upload(&w, &clip(), "sale").await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
        assert_eq!(r.body["code"], "no_speech");
    }
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM voice_utterances WHERE store_id=$1")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn chat_intent_and_transcribe_mode_return_the_transcript_without_a_draft() {
    let chat = VoiceParse {
        transcript: "hôm nay bán được bao nhiêu".into(),
        language: "vi".into(),
        intent: Intent::Chat,
        confidence: 0.8,
        ..VoiceParse::default()
    };
    let (w, _) = setup(vec![Step::parse(chat.clone()), Step::parse(chat)], |_| {}).await;
    for mode in ["sale", "transcribe"] {
        let r = upload(&w, &clip(), mode).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        ok(&w, r.status, &r.body);
        assert_eq!(r.body["intent"], "chat");
        assert_eq!(r.body["mode"], mode);
        assert!(r.body.get("sale_draft").is_none());
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn daily_quota_answers_429_voice_quota() {
    let parse = || {
        sale(
            "hai chai",
            vec![line("hai chai nước", "nước", Some(2.0), None, None, None)],
            "cash",
            None,
        )
    };
    let (w, model) = setup(vec![Step::parse(parse()), Step::parse(parse())], |c| {
        c.daily_utterances_per_store = 2;
    })
    .await;
    for _ in 0..2 {
        assert_eq!(
            upload(&w, &clip(), "sale").await.status,
            StatusCode::CREATED
        );
    }
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.body["code"], "voice_quota");
    assert!(r.headers.contains_key("retry-after"));
    assert_eq!(
        model.calls().len(),
        2,
        "no model call once the cap is spent"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn upload_validation_errors() {
    let (w, model) = setup(vec![], |c| c.max_bytes = 2048).await;
    // Not audio at all.
    let r = upload(&w, b"\xff\xd8\xff\xe0 this is a jpeg", "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("unsupported_format"))
    );
    // 45 seconds by container metadata, 30 allowed.
    let r = upload(&w, &fixtures::m4a(45.0, b"x"), "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("audio_too_long"))
    );
    let r = upload(&w, &fixtures::ogg(45.0), "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("audio_too_long"))
    );
    // Over VOICE_MAX_BYTES.
    let r = upload(&w, &fixtures::m4a(1.0, &vec![0u8; 4096]), "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("payload_too_large"))
    );
    // Missing or wrong fields.
    let r = upload_with(&w, &w.seller, Some(&clip()), &[("mode", "dance")], &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = upload_with(&w, &w.seller, None, &[("mode", "sale")], &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = upload_with(
        &w,
        &w.seller,
        Some(&clip()),
        &[
            ("mode", "sale"),
            ("context", r#"{"entry":"nope","screen":"x"}"#),
        ],
        &[],
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(model.calls().is_empty());
    // No token.
    let r = upload_with(&w, "bad", Some(&clip()), &[("mode", "sale")], &[]).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn fallback_chain_audio_slugs_then_stt_then_503() {
    let parse = || {
        sale(
            "hai chai nước",
            vec![line("hai chai nước", "nước", Some(2.0), None, None, None)],
            "cash",
            None,
        )
    };
    let (w, model) = setup(
        vec![
            // 1: first slug fails, second answers.
            Step::unavailable(),
            Step::parse(parse()),
            // 2: both audio slugs fail; STT then a text parse on the first slug.
            Step::unavailable(),
            Step::unavailable(),
            Step::transcript("hai chai nước"),
            Step::parse(VoiceParse {
                transcript: String::new(),
                ..parse()
            }),
            // 3: everything fails.
            Step::unavailable(),
            Step::unavailable(),
            Step::unavailable(),
        ],
        |_| {},
    )
    .await;
    w.product("Nước suối Aquafina", 6000, None).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(
        (r.body["model"].as_str(), r.body["stt_fallback"].as_bool()),
        (Some("g/two"), Some(false))
    );

    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    ok(&w, r.status, &r.body);
    assert_eq!(r.body["stt_fallback"], true);
    assert_eq!(
        r.body["model"], "p/one",
        "the STT text goes to VOICE_PARSE_MODELS"
    );
    assert_eq!(
        r.body["transcript"], "hai chai nước",
        "falls back to the STT text"
    );
    let kinds: Vec<_> = model
        .calls()
        .iter()
        .skip(2)
        .map(|c| match c {
            Call::Audio { model, .. } => format!("audio:{model}"),
            Call::Stt { model, .. } => format!("stt:{model}"),
            Call::Text { model, transcript } => format!("text:{model}:{transcript}"),
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "audio:g/one",
            "audio:g/two",
            "stt:w/stt",
            "text:p/one:hai chai nước"
        ]
    );

    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{}", r.body);
    assert_eq!(r.body["code"], "voice_unavailable");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn outcome_is_idempotent_and_ambiguous_picks_teach_aliases() {
    let ambiguous = || {
        sale(
            "ba chai nước mắm",
            vec![line(
                "ba chai nước mắm",
                "nước mắm",
                Some(3.0),
                None,
                None,
                None,
            )],
            "cash",
            None,
        )
    };
    let (w, _) = setup(
        vec![Step::parse(ambiguous()), Step::parse(ambiguous())],
        |_| {},
    )
    .await;
    let preselected = w.product("Nước mắm Chinsu", 32000, None).await;
    let picked = w.product("Nước mắm Nam Ngư", 30000, None).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.body["sale_draft"]["lines"][0]["status"], "ambiguous");
    let id = r.body["id"].as_str().unwrap().to_owned();
    let line_id = r.body["sale_draft"]["lines"][0]["id"].clone();
    let body =
        json!({"outcome":"edited","corrections":[{"line_id":line_id,"chosen_product_id":picked}]});
    assert_eq!(outcome(&w, &id, body.clone()).await, StatusCode::NO_CONTENT);
    assert_eq!(outcome(&w, &id, body).await, StatusCode::NO_CONTENT);
    // Last write wins for the outcome; learning ran once.
    assert_eq!(
        outcome(&w, &id, json!({"outcome":"abandoned","stage":"pay"})).await,
        StatusCode::NO_CONTENT
    );
    let (o, stage): (String, Option<String>) =
        sqlx::query_as("SELECT outcome, stage FROM voice_utterances WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!((o.as_str(), stage.as_deref()), ("abandoned", Some("pay")));
    let (product, hits): (Uuid, i32) = sqlx::query_as(
        "SELECT product_id, hits FROM voice_aliases WHERE store_id=$1 AND phrase='nuoc mam'",
    )
    .bind(w.store_id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!((product, hits), (picked, 2));
    // The alias now decides the next utterance of the phrase.
    let r = upload(&w, &clip(), "sale").await;
    ok(&w, r.status, &r.body);
    let l = &r.body["sale_draft"]["lines"][0];
    assert_eq!(
        (l["status"].as_str(), l["product"]["id"].clone()),
        (Some("matched"), json!(picked))
    );
    assert_ne!(l["product"]["id"], json!(preselected));
    // Unknown utterance, other member's utterance, bad body.
    assert_eq!(
        outcome(
            &w,
            &Uuid::new_v4().to_string(),
            json!({"outcome":"confirmed"})
        )
        .await,
        StatusCode::NOT_FOUND
    );
    let lead = w
        .call(
            "POST",
            &format!("{PATH}/{id}/outcome"),
            &w.lead,
            json!({"outcome":"confirmed"}),
        )
        .await;
    assert_eq!(lead.status, StatusCode::NOT_FOUND);
    assert_eq!(
        outcome(&w, &id, json!({"outcome":"maybe"})).await,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn two_corrections_of_one_phrase_teach_an_alias() {
    let matched = || {
        sale(
            "một lon coca",
            vec![line("lon coca", "coca", Some(1.0), None, None, None)],
            "cash",
            None,
        )
    };
    let (w, _) = setup(
        vec![
            Step::parse(matched()),
            Step::parse(matched()),
            Step::parse(matched()),
        ],
        |_| {},
    )
    .await;
    let coca = w.product("Coca Cola", 10000, None).await;
    let pepsi = w.product("Pepsi", 10000, None).await;
    for round in 0..2 {
        let r = upload(&w, &clip(), "sale").await;
        let l = &r.body["sale_draft"]["lines"][0];
        assert_eq!(l["product"]["id"], json!(coca), "round {round}");
        let id = r.body["id"].as_str().unwrap();
        let body = json!({"outcome":"edited","corrections":[{"line_id":l["id"],"chosen_product_id":pepsi}]});
        assert_eq!(outcome(&w, id, body).await, StatusCode::NO_CONTENT);
        let hits: i32 = sqlx::query_scalar(
            "SELECT hits FROM voice_aliases WHERE store_id=$1 AND phrase='coca'",
        )
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap();
        assert_eq!(hits, round + 1);
    }
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        r.body["sale_draft"]["lines"][0]["product"]["id"],
        json!(pepsi)
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn retention_deletes_old_rows_except_donated() {
    let (w, _) = setup(vec![], |_| {}).await;
    let mut ids = vec![];
    for (age, donated) in [(31, false), (31, true), (5, false)] {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO voice_utterances(id,store_id,member,mode,intent,transcript,model,latency_ms,donated,created_at) VALUES($1,$2,$3,'sale','sale','x','m',1,$4,now()-make_interval(days=>$5))")
            .bind(id).bind(w.store_id).bind(w.seller_id).bind(donated).bind(age)
            .execute(w.pool()).await.unwrap();
        ids.push(id);
    }
    let deleted = taphoa_api::voice::retention::run_once(w.pool())
        .await
        .unwrap();
    assert!(deleted >= 1);
    let left: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM voice_utterances WHERE store_id=$1 ORDER BY created_at")
            .bind(w.store_id)
            .fetch_all(w.pool())
            .await
            .unwrap();
    assert!(!left.contains(&ids[0]) && left.contains(&ids[1]) && left.contains(&ids[2]));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn eval_model_header_needs_the_flag_and_a_configured_slug() {
    let parse = || {
        sale(
            "hai chai",
            vec![line("hai chai nước", "nước", Some(2.0), None, None, None)],
            "cash",
            None,
        )
    };
    // (flag, header slug, slug the chain should use)
    for (allow, header, expected) in [
        (true, "g/two", "g/two"),
        (true, "w/stt", "w/stt"),
        (true, "attacker/model", "g/one"),
        (false, "g/two", "g/one"),
    ] {
        let (w, model) = setup(vec![Step::parse(parse())], |c| c.allow_eval_headers = allow).await;
        let r = upload_with(
            &w,
            &w.seller,
            Some(&clip()),
            &[("mode", "sale")],
            &[("x-taphoa-eval-model", header)],
        )
        .await;
        assert_eq!(r.status, StatusCode::CREATED, "{header}: {}", r.body);
        assert_eq!(r.body["model"], expected, "{header} allow={allow}");
        match &model.calls()[0] {
            Call::Audio { model, .. } => assert_eq!(model, expected),
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn server_faults_refund_the_quota_unit_but_no_speech_and_chat_keep_it() {
    let silent = || VoiceParse {
        intent: Intent::None,
        ..VoiceParse::default()
    };
    let chat = || VoiceParse {
        transcript: "bán được bao nhiêu".into(),
        intent: Intent::Chat,
        ..VoiceParse::default()
    };
    // Cap 1: a 503 gives the unit back, so the retry is served; the 422 then spends it.
    let (w, _) = setup(
        vec![
            Step::unavailable(),
            Step::unavailable(),
            Step::unavailable(),
            Step::unavailable(),
            Step::parse(silent()),
        ],
        |c| {
            c.daily_utterances_per_store = 1;
            c.models = vec!["g/one".into()];
        },
    )
    .await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("voice_unavailable"))
    );
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        r.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "retry reached the model, not a 429: {}",
        r.body
    );
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("no_speech"))
    );
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("voice_quota")),
        "no_speech keeps its unit"
    );

    let (w, _) = setup(vec![Step::parse(chat())], |c| {
        c.daily_utterances_per_store = 1
    })
    .await;
    assert_eq!(
        upload(&w, &clip(), "sale").await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        upload(&w, &clip(), "sale").await.status,
        StatusCode::TOO_MANY_REQUESTS,
        "chat keeps its unit"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn clips_of_unknown_duration_are_bounded_by_a_size_estimate() {
    let ok_parse = sale(
        "hai chai",
        vec![line("hai chai nước", "nước", Some(2.0), None, None, None)],
        "cash",
        None,
    );
    let (w, model) = setup(vec![Step::parse(ok_parse)], |_| {}).await;
    // ftyp only: no moov, so no readable duration. 30 s at 48 kbps is 180,000 bytes (+16 KB).
    let mut unreadable = b"\0\0\0\x14ftypM4A \0\0\0\0M4A ".to_vec();
    let small = {
        let mut v = unreadable.clone();
        v.extend(vec![0u8; 100_000]);
        v
    };
    unreadable.extend(vec![0u8; 400_000]);
    let r = upload(&w, &unreadable, "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("audio_too_long"))
    );
    assert!(model.calls().is_empty());
    let r = upload(&w, &small, "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn the_utterance_deadline_stops_the_chain_with_503() {
    let (w, model) = setup(
        vec![
            Step::Delay(
                std::time::Duration::from_secs(5),
                Box::new(Step::unavailable()),
            ),
            Step::unavailable(),
            Step::unavailable(),
            Step::unavailable(),
        ],
        |c| c.total_timeout = std::time::Duration::from_millis(300),
    )
    .await;
    let started = std::time::Instant::now();
    let r = upload(&w, &clip(), "sale").await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("voice_unavailable"))
    );
    assert_eq!(model.calls().len(), 1, "no call starts after the deadline");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn outcome_sale_id_must_belong_to_the_store() {
    let parse = || {
        sale(
            "hai chai",
            vec![line("hai chai nước", "nước", Some(2.0), None, None, None)],
            "cash",
            None,
        )
    };
    let (w, _) = setup(vec![Step::parse(parse())], |_| {}).await;
    let r = upload(&w, &clip(), "sale").await;
    let id = r.body["id"].as_str().unwrap().to_owned();
    // A sale of another store.
    let other = World::new().await;
    let p = other.product("X", 1000, None).await;
    let foreign = Uuid::now_v7();
    other
        .checked(
            "POST",
            "/v1/sales",
            "/v1/sales",
            &other.seller,
            common::world::sale_body(foreign, &now_iso(), "cash", &[(p, 1, 1000)]),
            StatusCode::CREATED,
        )
        .await;
    let reply = w
        .call(
            "POST",
            &format!("{PATH}/{id}/outcome"),
            &w.seller,
            json!({"outcome":"confirmed","sale_id":foreign}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
    assert_eq!(reply.body["code"], "validation_failed");
    let stored: Option<Uuid> =
        sqlx::query_scalar("SELECT sale_id FROM voice_utterances WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(stored, None);
    // A sale of this store is stored.
    let mine = Uuid::now_v7();
    let p = w.product("Y", 1000, None).await;
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        common::world::sale_body(mine, &now_iso(), "cash", &[(p, 1, 1000)]),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        outcome(&w, &id, json!({"outcome":"confirmed","sale_id":mine})).await,
        StatusCode::NO_CONTENT
    );
    let stored: Option<Uuid> =
        sqlx::query_scalar("SELECT sale_id FROM voice_utterances WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(stored, Some(mine));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn accepting_a_preselected_ambiguous_line_teaches_only_when_confirmed() {
    let ambiguous = || {
        sale(
            "ba chai nước mắm",
            vec![line(
                "ba chai nước mắm",
                "nước mắm",
                Some(3.0),
                None,
                None,
                None,
            )],
            "cash",
            None,
        )
    };
    let (w, _) = setup(
        vec![Step::parse(ambiguous()), Step::parse(ambiguous())],
        |_| {},
    )
    .await;
    w.product("Nước mắm Nam Ngư", 32000, None).await;
    w.product("Nước mắm Chinsu", 30000, None).await;
    let first = upload(&w, &clip(), "sale").await;
    let id = first.body["id"].as_str().unwrap();
    let preselected = first.body["sale_draft"]["lines"][0]["product"]["id"].clone();
    assert_eq!(
        outcome(&w, id, json!({"outcome":"edited"})).await,
        StatusCode::NO_CONTENT
    );
    let aliases = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM voice_aliases WHERE store_id=$1")
            .bind(w.store_id)
            .fetch_one(w.pool())
            .await
            .unwrap()
    };
    assert_eq!(aliases().await, 0, "edited without a pick teaches nothing");
    // A second utterance, confirmed as drafted, teaches the preselected product.
    let second = upload(&w, &clip(), "sale").await;
    assert_eq!(
        second.body["sale_draft"]["lines"][0]["product"]["id"],
        preselected
    );
    let id = second.body["id"].as_str().unwrap();
    assert_eq!(
        outcome(&w, id, json!({"outcome":"confirmed"})).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(aliases().await, 1);
    let product: Uuid =
        sqlx::query_scalar("SELECT product_id FROM voice_aliases WHERE store_id=$1")
            .bind(w.store_id)
            .fetch_one(w.pool())
            .await
            .unwrap();
    assert_eq!(json!(product), preselected);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn voice_sale_lines_are_accepted_move_stock_and_count_in_the_event() {
    let (w, _) = setup(vec![], |_| {}).await;
    let p = w.product("Coca Cola", 10000, None).await;
    sqlx::query("UPDATE products SET stock_quantity=10 WHERE id=$1")
        .bind(p)
        .execute(w.pool())
        .await
        .unwrap();
    let id = Uuid::now_v7();
    let body = json!({
        "id": id, "sold_at": now_iso(), "payment_method": "cash", "total": 25000,
        "lines": [
            {"id": Uuid::now_v7(), "product_id": p, "source": "voice", "quantity": 2, "unit_price": 10000},
            {"id": Uuid::now_v7(), "product_id": null, "source": "manual", "manual_label": "gạo ST25", "quantity": 1, "unit_price": 5000},
        ],
    });
    w.checked(
        "POST",
        "/v1/sales",
        "/v1/sales",
        &w.seller,
        body,
        StatusCode::CREATED,
    )
    .await;
    let stock: i32 = sqlx::query_scalar("SELECT stock_quantity FROM products WHERE id=$1")
        .bind(p)
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert_eq!(stock, 8);
    let source: String = sqlx::query_scalar(
        "SELECT source FROM sale_lines WHERE sale_id=$1 AND product_id IS NOT NULL",
    )
    .bind(id)
    .fetch_one(w.pool())
    .await
    .unwrap();
    assert_eq!(source, "voice");
    let voice_lines: i64 = sqlx::query_scalar("SELECT (payload->'data'->>'voice_lines')::bigint FROM outbox_events WHERE store_id=$1 AND type='sale.created'")
        .bind(w.store_id)
        .fetch_one(w.pool())
        .await
        .unwrap_or(-1);
    assert_eq!(voice_lines, 1);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_model_price_that_was_not_spoken_is_replaced_by_the_catalog_price() {
    // The model echoes the catalog price as unit_price and says nothing in price_spoken.
    let parse = sale(
        "một chai nước suối lavie",
        vec![line(
            "một chai nước suối lavie",
            "nước suối lavie",
            Some(1.0),
            Some("chai"),
            Some(8000.0),
            None,
        )],
        "cash",
        None,
    );
    let (w, _) = setup(vec![Step::parse(parse)], |_| {}).await;
    w.product("Nước suối Lavie", 8000, None).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    ok(&w, r.status, &r.body);
    let l = &r.body["sale_draft"]["lines"][0];
    assert_eq!(l["price_source"], "catalog");
    assert_eq!(l["unit_price"], 8000);
    assert_eq!(l["price_mismatch"], false);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn invented_lines_on_silence_are_dropped_into_no_speech() {
    let invented = |transcript: &str| {
        sale(
            transcript,
            vec![
                line(
                    "2 lon bia Tiger",
                    "bia Tiger",
                    Some(2.0),
                    Some("lon"),
                    None,
                    None,
                ),
                line(
                    "1 gói mì Hảo Hảo",
                    "mì Hảo Hảo",
                    Some(1.0),
                    Some("gói"),
                    None,
                    None,
                ),
            ],
            "cash",
            None,
        )
    };
    let (w, _) = setup(
        vec![Step::parse(invented("")), Step::parse(invented("ừm"))],
        |_| {},
    )
    .await;
    w.product("Bia Tiger", 18000, None).await;
    w.product("Mì Hảo Hảo", 4500, None).await;
    for _ in 0..2 {
        let r = upload(&w, &clip(), "sale").await;
        assert_eq!(
            (r.status, r.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("no_speech")),
            "{}",
            r.body
        );
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn only_the_ungrounded_lines_are_dropped() {
    let parse = sale(
        "hai lon bia tiger",
        vec![
            line(
                "hai lon bia tiger",
                "bia tiger",
                Some(2.0),
                Some("lon"),
                None,
                None,
            ),
            line(
                "một gói mì hảo hảo",
                "mì hảo hảo",
                Some(1.0),
                None,
                None,
                None,
            ),
        ],
        "cash",
        None,
    );
    let (w, _) = setup(vec![Step::parse(parse)], |_| {}).await;
    w.product("Bia Tiger", 18000, None).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["sale_draft"]["lines"].as_array().unwrap().len(), 1);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn rate_limits_move_to_the_next_slug_and_retry_the_last_once() {
    let ok = || {
        sale(
            "hai chai",
            vec![line("hai chai nước", "nước", Some(2.0), None, None, None)],
            "cash",
            None,
        )
    };
    let limited = || {
        Step::error(taphoa_api::assistant::model::ModelError::RateLimited {
            status: 429,
            message: "slow down".into(),
        })
    };
    // First slug limited: the second answers, no 503.
    let (w, model) = setup(vec![limited(), Step::parse(ok())], |_| {}).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        (
            r.status,
            r.body["model"].as_str(),
            r.body["stt_fallback"].as_bool()
        ),
        (StatusCode::CREATED, Some("g/two"), Some(false)),
        "{}",
        r.body
    );
    assert_eq!(model.calls().len(), 2);
    // Both limited: the last slug gets one more try after a short pause.
    let (w, model) = setup(vec![limited(), limited(), Step::parse(ok())], |_| {}).await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(
        (r.status, r.body["model"].as_str()),
        (StatusCode::CREATED, Some("g/two")),
        "{}",
        r.body
    );
    let slugs: Vec<_> = model
        .calls()
        .iter()
        .map(|c| match c {
            Call::Audio { model, .. } => model.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(slugs, ["g/one", "g/two", "g/two"]);
    // A single configured slug is retried once as well, and only once.
    let (w, model) = setup(vec![limited(), limited(), Step::unavailable()], |c| {
        c.models = vec!["g/one".into()]
    })
    .await;
    let r = upload(&w, &clip(), "sale").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{}", r.body);
    // Two audio calls (original and one retry), then the STT call.
    assert_eq!(model.calls().len(), 3);
}

const SILENCE_CLIP: &[u8] = include_bytes!("../src/voice/testdata/39-silence.m4a");
const NOISE_CLIP: &[u8] = include_bytes!("../src/voice/testdata/40-noise-only.m4a");
const SPEECH_CLIP: &[u8] = include_bytes!("../src/voice/testdata/08-single-omo.m4a");
const NOISY_SPEECH_CLIP: &[u8] = include_bytes!("../src/voice/testdata/49-noise-two-line.m4a");

#[tokio::test]
#[ignore = "requires Postgres"]
async fn silence_and_noise_never_reach_the_model() {
    let invented = || {
        sale(
            "Cho mình lấy 2 lon bia Tiger, 1 gói mì Hảo Hảo",
            vec![line(
                "2 lon bia Tiger",
                "bia Tiger",
                Some(2.0),
                Some("lon"),
                None,
                None,
            )],
            "cash",
            None,
        )
    };
    let (w, model) = setup(
        vec![Step::parse(invented()), Step::parse(invented())],
        |_| {},
    )
    .await;
    w.product("Bia Tiger", 18000, None).await;
    for clip in [SILENCE_CLIP, NOISE_CLIP] {
        for mode in ["sale", "transcribe"] {
            let r = upload(&w, clip, mode).await;
            assert_eq!(
                (r.status, r.body["code"].as_str()),
                (StatusCode::UNPROCESSABLE_ENTITY, Some("no_speech")),
                "{mode}: {}",
                r.body
            );
        }
    }
    assert!(
        model.calls().is_empty(),
        "the gate answers before any model call"
    );
    // Real speech, quiet or over noise, goes through to the model.
    let spoken = || {
        sale(
            "một lon bia tiger",
            vec![line(
                "lon bia tiger",
                "bia tiger",
                Some(1.0),
                None,
                None,
                None,
            )],
            "cash",
            None,
        )
    };
    let (w, model) = setup(vec![Step::parse(spoken()), Step::parse(spoken())], |_| {}).await;
    w.product("Bia Tiger", 18000, None).await;
    for clip in [SPEECH_CLIP, NOISY_SPEECH_CLIP] {
        let r = upload(&w, clip, "sale").await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    }
    assert_eq!(model.calls().len(), 2);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_transcript_denser_than_speech_is_an_invention() {
    // A 3 s clip cannot hold 22 words.
    let long = "Cho mình lấy 2 lon bia Tiger, 1 gói mì Hảo Hảo tôm chua cay, với 1 chai nước suối Lavie nhé";
    let made_up = sale(
        long,
        vec![line(
            "2 lon bia Tiger",
            "bia Tiger",
            Some(2.0),
            Some("lon"),
            None,
            None,
        )],
        "cash",
        None,
    );
    let (w, model) = setup(vec![Step::parse(made_up)], |_| {}).await;
    w.product("Bia Tiger", 18000, None).await;
    let r = upload(&w, SPEECH_CLIP, "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("no_speech")),
        "{}",
        r.body
    );
    assert_eq!(
        model.calls().len(),
        1,
        "the model ran, the guard rejected its transcript"
    );
}

const CATALOG_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/voice/testdata/rank_catalog.txt"
));

/// The catalog the matching tests run against: name and id of each product.
async fn seed_catalog(w: &World) -> Vec<(String, Uuid)> {
    let mut out = Vec::new();
    for name in CATALOG_TEXT.lines().filter(|l| !l.is_empty()) {
        out.push((name.to_owned(), w.product(name, 15000, None).await));
    }
    out
}

const CASH: &str = "cash";

fn plain_line(said: &str, quantity: Option<f64>) -> VoiceParse {
    let one = line(said, said, quantity, None, None, None);
    sale(said, vec![one], CASH, None)
}

const CHILI_WORDINGS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/voice/testdata/wordings_chili.txt"
));

const MATCHED: &str = concat!("matc", "hed");
const AMBIGUOUS: &str = concat!("ambig", "uous");
const UNKNOWN: &str = concat!("unkn", "own");

#[tokio::test]
#[ignore = "requires Postgres"]
async fn different_wordings_of_one_product_resolve_to_it() {
    let phrases: Vec<&str> = CHILI_WORDINGS.lines().collect();
    let steps = phrases.iter().map(|p| Step::parse(plain_line(p, None)));
    let (w, _) = setup(steps.collect(), |_| {}).await;
    let chili = seed_catalog(&w).await.first().map(|c| c.1);
    for phrase in phrases {
        let r = upload(&w, &clip(), MODE).await;
        assert_eq!((phrase, r.status), (phrase, StatusCode::CREATED));
        ok(&w, r.status, &r.body);
        let l = &r.body["sale_draft"]["lines"][0];
        assert_eq!((phrase, l["status"].as_str()), (phrase, Some(MATCHED)));
        assert_eq!((phrase, l["product"]["id"].clone()), (phrase, json!(chili)));
    }
}

const MODE: &str = concat!("sa", "le");

const GENERIC: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/voice/testdata/generic_case.tsv"
));

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_generic_name_is_ambiguous_with_ranked_candidates() {
    let cols: Vec<&str> = GENERIC.trim().split(char::from(9u8)).collect();
    let step = Step::parse(plain_line(cols[0], None));
    let (w, _) = setup(Vec::from_iter(std::iter::once(step)), |_| {}).await;
    seed_catalog(&w).await;
    let r = upload(&w, &clip(), MODE).await;
    assert_eq!(r.status, StatusCode::CREATED);
    ok(&w, r.status, &r.body);
    let l = &r.body["sale_draft"]["lines"][0];
    assert_eq!(l["status"].as_str(), Some(AMBIGUOUS));
    assert_eq!(l["spoken"].as_str(), Some(cols[1]));
    assert_eq!(l["quantity"].as_i64(), cols[2].parse::<i64>().ok());

    const SODAS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/voice/testdata/soda_brands.txt"
    ));
    let candidates = l["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 3);
    let first = candidates.first().unwrap();
    assert_eq!(l["product"]["id"], first["id"]);
    let names = candidates
        .iter()
        .map(|c| c["name"].as_str().unwrap_or_default().to_lowercase());
    let names: Vec<String> = names.collect();
    let in_list = |n: &String| SODAS.split_whitespace().any(|s| n.starts_with(s));
    assert!(names.iter().all(in_list));
}

const UNKNOWN_WORDINGS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/voice/testdata/wordings_unknown.txt"
));

#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_unknown_product_keeps_only_its_name_in_the_line() {
    let phrases: Vec<&str> = UNKNOWN_WORDINGS.lines().collect();
    let name = phrases.first().copied();
    let steps = phrases.iter().map(|p| Step::parse(plain_line(p, None)));
    let (w, _) = setup(steps.collect(), |_| {}).await;
    seed_catalog(&w).await;
    for phrase in phrases {
        let r = upload(&w, &clip(), MODE).await;
        assert_eq!((phrase, r.status), (phrase, StatusCode::CREATED));
        let l = &r.body["sale_draft"]["lines"][0];
        assert_eq!((phrase, l["status"].as_str()), (phrase, Some(UNKNOWN)));
        assert_eq!((phrase, l["spoken"].as_str()), (phrase, name));
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn header_that_understates_the_duration_is_still_bounded() {
    let (w, model) = setup(vec![], |c| c.max_seconds = 2).await;
    // 5 s of PCM whose byte rate claims 1000x, so the container says 5 ms.
    let mut wav = fixtures::wav(5.0);
    wav[28..32].copy_from_slice(&32_000_000u32.to_le_bytes());
    let r = upload(&w, &wav, "sale").await;
    assert_eq!(
        (r.status, r.body["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("audio_too_long")),
        "{}",
        r.body
    );
    assert!(
        model.calls().is_empty(),
        "no model call for an overlong clip"
    );
}

#[derive(Default)]
struct Keep(std::sync::Mutex<Vec<String>>);
#[async_trait::async_trait]
impl taphoa_api::storage::ObjectStore for Keep {
    async fn put(&self, key: &str, _: &str, _: Vec<u8>) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(key.into());
        Ok(())
    }
    async fn delete(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn head_bucket(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn presign_get(
        &self,
        _: &str,
        _: std::time::Duration,
    ) -> anyhow::Result<taphoa_api::storage::SignedUrl> {
        anyhow::bail!("not used")
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn donated_clip_is_kept_only_with_the_opt_in() {
    let parse = sale(
        "hai chai nuoc mam",
        vec![line(
            "hai chai nuoc mam",
            "nuoc mam",
            Some(2.0),
            None,
            None,
            None,
        )],
        "cash",
        None,
    );
    let (mut w, _model) = setup(vec![Step::parse(parse.clone()), Step::parse(parse)], |_| {}).await;
    w.product("Nuoc mam", 30000, None).await;
    let store = std::sync::Arc::new(Keep::default());
    w.state.storage = Some(store.clone());
    w.app = taphoa_api::router(w.state.clone());
    let fields = [("mode", "sale"), ("language", "vi")];
    let mut with_donate = fields.to_vec();
    with_donate.push(("donate", "true"));
    // Without the flag the clip is not kept.
    let r = upload_with(&w, &w.seller, Some(&clip()), &fields, &[]).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert!(store.0.lock().unwrap().is_empty());
    let donated: bool = sqlx::query_scalar("SELECT donated FROM voice_utterances WHERE id=$1")
        .bind(r.body["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert!(!donated);
    // With donate=true it is stored under voice/<store>/<uuid>.m4a and the row is marked.
    let r = upload_with(&w, &w.seller, Some(&clip()), &with_donate, &[]).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_owned();
    let keys = store.0.lock().unwrap().clone();
    assert_eq!(keys, vec![format!("voice/{}/{}.m4a", w.store_id, id)]);
    let donated: bool = sqlx::query_scalar("SELECT donated FROM voice_utterances WHERE id=$1")
        .bind(id.parse::<Uuid>().unwrap())
        .fetch_one(w.pool())
        .await
        .unwrap();
    assert!(donated);
    // A malformed flag is a 400.
    let bad = [("mode", "sale"), ("donate", "maybe")];
    let r = upload_with(&w, &w.seller, Some(&clip()), &bad, &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}
