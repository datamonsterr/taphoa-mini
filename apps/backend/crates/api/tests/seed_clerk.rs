//! Seeded members are linked to Clerk test users through a local stub of the Clerk
//! Backend API (`GET/POST /v1/users`). Never calls the real Clerk API.
//!
//! The database tests need `DATABASE_URL` (they create and drop a private database each):
//! `cargo nextest run --run-ignored only --test-threads 1 -E 'binary(/seed_clerk/)'`.
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use sqlx::{
    Connection, PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{
    future::Future,
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use taphoa_api::seed::{ClerkUsers, run_with};

const KEY: &str = "sk_test_seed_stub_key";
const LEAD_EMAIL: &str = "seed-coba-me+clerk_test@example.com";

#[derive(Default)]
struct Stub {
    users: Vec<(String, String)>,
    gets: usize,
    posts: usize,
    throttled: usize,
    bad_auth: usize,
    bad_body: usize,
    /// The next requests answer 429 with `Retry-After: 0`.
    throttle: usize,
    /// The next list answers empty but a competitor creates that user meanwhile.
    ghost_on_next_list: bool,
    queried: Vec<String>,
    first_names: Vec<String>,
}
type Shared = Arc<Mutex<Stub>>;

fn authorized(stub: &mut Stub, headers: &HeaderMap) -> Option<Response> {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        != Some(&format!("Bearer {KEY}"))
    {
        stub.bad_auth += 1;
        return Some(StatusCode::UNAUTHORIZED.into_response());
    }
    if stub.throttle > 0 {
        stub.throttle -= 1;
        stub.throttled += 1;
        let mut response =
            (StatusCode::TOO_MANY_REQUESTS, Json(json!({"errors": []}))).into_response();
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("0"));
        return Some(response);
    }
    None
}

fn user_json(id: &str, email: &str) -> Value {
    json!({"id": id, "object": "user", "email_addresses": [{"email_address": email}]})
}

async fn list(
    State(shared): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<Vec<(String, String)>>,
) -> Response {
    let mut stub = shared.lock().unwrap();
    stub.gets += 1;
    if let Some(early) = authorized(&mut stub, &headers) {
        return early;
    }
    let emails: Vec<String> = query
        .into_iter()
        .filter(|(name, _)| name == "email_address")
        .map(|(_, value)| value)
        .collect();
    stub.queried.extend(emails.iter().cloned());
    if stub.ghost_on_next_list {
        stub.ghost_on_next_list = false;
        let id = format!("user_stub_{}", stub.users.len() + 1);
        stub.users.push((id, emails[0].clone()));
        return Json(json!([])).into_response();
    }
    let found: Vec<Value> = stub
        .users
        .iter()
        .filter(|(_, email)| {
            emails
                .iter()
                .any(|wanted| wanted.eq_ignore_ascii_case(email))
        })
        .map(|(id, email)| user_json(id, email))
        .collect();
    Json(found).into_response()
}

async fn create(
    State(shared): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let mut stub = shared.lock().unwrap();
    stub.posts += 1;
    if let Some(early) = authorized(&mut stub, &headers) {
        return early;
    }
    let email = body["email_address"][0]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let first_name = body["first_name"].as_str().unwrap_or_default().to_owned();
    if body["email_address"].as_array().map(Vec::len) != Some(1)
        || email.is_empty()
        || first_name.is_empty()
        || body["skip_password_requirement"] != json!(true)
    {
        stub.bad_body += 1;
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"errors": [{"code": "bad_body"}]})),
        )
            .into_response();
    }
    if stub
        .users
        .iter()
        .any(|(_, existing)| existing.eq_ignore_ascii_case(&email))
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"errors": [{"code": "form_identifier_exists"}]})),
        )
            .into_response();
    }
    let id = format!("user_stub_{}", stub.users.len() + 1);
    stub.users.push((id.clone(), email.clone()));
    stub.first_names.push(first_name);
    Json(user_json(&id, &email)).into_response()
}

async fn stub() -> (String, Shared) {
    let shared = Shared::default();
    let app = Router::new()
        .route("/v1/users", get(list).post(create))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, shared)
}

fn client(url: &str) -> ClerkUsers {
    ClerkUsers::new(url, KEY).with_min_interval(Duration::ZERO)
}

fn all_seed_emails() -> Vec<String> {
    let mut emails = Vec::new();
    for store in ["coba", "minhkhai"] {
        for member in ["me", "ba-noi", "con-trai", "co-lan"] {
            emails.push(format!("seed-{store}-{member}+clerk_test@example.com"));
        }
    }
    emails
}

/// Runs `body` against a private migrated database, dropped afterwards even on failure.
async fn with_db<F, Fut>(body: F) -> anyhow::Result<()>
where
    F: FnOnce(PgPool, String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let url = std::env::var("DATABASE_URL")?;
    let base = PgConnectOptions::from_str(&url)?;
    let name = format!("seed_clerk_{}", uuid::Uuid::new_v4().simple());
    let mut admin = PgConnection::connect_with(&base).await?;
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(base.clone().database(&name))
        .await?;
    let (head, tail) = url
        .split_once('?')
        .map_or((url.as_str(), ""), |(h, t)| (h, t));
    let private_url = format!(
        "{}/{name}{}{tail}",
        head.rsplit_once('/').unwrap().0,
        if tail.is_empty() { "" } else { "?" }
    );
    let result = async {
        taphoa_api::MIGRATOR.run(&pool).await?;
        body(pool.clone(), private_url).await
    }
    .await;
    pool.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE {name} WITH (FORCE)"
    )))
    .execute(&mut admin)
    .await?;
    result
}

async fn linked(pool: &PgPool) -> anyhow::Result<Vec<(uuid::Uuid, String)>> {
    Ok(
        sqlx::query_as("SELECT id,clerk_user_id FROM members ORDER BY store_id,id")
            .fetch_all(pool)
            .await?,
    )
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_clerk_first_run_creates_users_and_links_members() -> anyhow::Result<()> {
    let (url, shared) = stub().await;
    with_db(|pool, _| async move {
        let report = run_with(&pool, Some(&client(&url))).await?;
        assert!(report.clerk_linked);
        {
            let stub = shared.lock().unwrap();
            assert_eq!(stub.users.len(), 8, "2 stores x 4 members");
            assert_eq!((stub.posts, stub.bad_auth, stub.bad_body), (8, 0, 0));
            let mut emails: Vec<_> = stub.users.iter().map(|(_, e)| e.clone()).collect();
            emails.sort();
            let mut expected = all_seed_emails();
            expected.sort();
            assert_eq!(emails, expected);
            assert!(stub.first_names.contains(&"Mẹ".to_string()));
        }
        let rows = linked(&pool).await?;
        assert_eq!(rows.len(), 8);
        for store in &report.stores {
            for member in &store.members {
                let id = member.clerk_user_id.clone().expect("Clerk id in report");
                assert!(
                    shared
                        .lock()
                        .unwrap()
                        .users
                        .iter()
                        .any(|(uid, email)| *uid == id && *email == member.email)
                );
                assert!(
                    rows.contains(&(member.member_id, id)),
                    "member {} not linked",
                    member.email
                );
            }
        }
        assert!(rows.iter().all(|(_, id)| id.starts_with("user_stub_")));
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_clerk_second_run_creates_no_users_and_no_members() -> anyhow::Result<()> {
    let (url, shared) = stub().await;
    with_db(|pool, _| async move {
        let clerk = client(&url);
        run_with(&pool, Some(&clerk)).await?;
        let first = linked(&pool).await?;
        run_with(&pool, Some(&clerk)).await?;
        {
            let stub = shared.lock().unwrap();
            assert_eq!(
                stub.users.len(),
                8,
                "second run must not create Clerk users"
            );
            assert_eq!(stub.posts, 8);
            assert_eq!(stub.gets, 16, "one lookup per member per run");
        }
        assert_eq!(
            first,
            linked(&pool).await?,
            "second run changed member links"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_clerk_reuses_a_user_that_already_has_the_email() -> anyhow::Result<()> {
    let (url, shared) = stub().await;
    shared
        .lock()
        .unwrap()
        .users
        .push(("user_preexisting".into(), LEAD_EMAIL.into()));
    with_db(|pool, _| async move {
        let report = run_with(&pool, Some(&client(&url))).await?;
        {
            let stub = shared.lock().unwrap();
            assert_eq!(stub.users.len(), 8);
            assert_eq!(stub.posts, 7, "the existing user is not created again");
        }
        let lead = &report.stores[0].members[0];
        assert_eq!(lead.email, LEAD_EMAIL);
        assert_eq!(lead.clerk_user_id.as_deref(), Some("user_preexisting"));
        let stored: String = sqlx::query_scalar("SELECT clerk_user_id FROM members WHERE id=$1")
            .bind(lead.member_id)
            .fetch_one(&pool)
            .await?;
        assert_eq!(stored, "user_preexisting");
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_clerk_retries_429_then_succeeds() -> anyhow::Result<()> {
    let (url, shared) = stub().await;
    shared.lock().unwrap().throttle = 3;
    with_db(|pool, _| async move {
        run_with(&pool, Some(&client(&url))).await?;
        {
            let stub = shared.lock().unwrap();
            assert_eq!(stub.throttled, 3);
            assert_eq!(stub.users.len(), 8);
        }
        assert_eq!(linked(&pool).await?.len(), 8);
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_clerk_upgrades_placeholder_ids_and_never_downgrades() -> anyhow::Result<()> {
    let (url, shared) = stub().await;
    with_db(|pool, _| async move {
        // An older seed (or one without CLERK_SECRET_KEY) left placeholder ids behind.
        run_with(&pool, None).await?;
        let placeholders = linked(&pool).await?;
        assert!(
            placeholders
                .iter()
                .all(|(id, user)| *user == format!("seed_{id}"))
        );
        assert_eq!(
            shared.lock().unwrap().gets,
            0,
            "no Clerk calls without a client"
        );

        run_with(&pool, Some(&client(&url))).await?;
        let upgraded = linked(&pool).await?;
        assert_eq!(upgraded.len(), 8, "relinking must not add members");
        assert!(
            upgraded
                .iter()
                .all(|(_, user)| user.starts_with("user_stub_"))
        );

        run_with(&pool, None).await?;
        assert_eq!(
            upgraded,
            linked(&pool).await?,
            "a keyless rerun downgraded real ids"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_clerk_relinks_when_a_user_was_deleted_from_clerk() -> anyhow::Result<()> {
    let (url, shared) = stub().await;
    with_db(|pool, _| async move {
        let clerk = client(&url);
        run_with(&pool, Some(&clerk)).await?;
        let before = linked(&pool).await?;
        shared.lock().unwrap().users.clear();
        run_with(&pool, Some(&clerk)).await?;
        let after = linked(&pool).await?;
        assert_eq!(after.len(), 8);
        assert_eq!(shared.lock().unwrap().users.len(), 8, "users are recreated");
        assert_eq!(before.len(), after.len());
        let ids: Vec<_> = after.iter().map(|(_, user)| user.clone()).collect();
        let stub_ids: Vec<_> = shared
            .lock()
            .unwrap()
            .users
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            assert!(stub_ids.contains(&id));
        }
        Ok(())
    })
    .await
}

/// Path of the `taphoa-seed` binary. `env!("CARGO_BIN_EXE_...")` is baked in at compile time and
/// points at the build machine, which breaks `cargo nextest run --archive-file ... --workspace-remap`
/// on another runner. nextest sets the variables below at run time with the remapped path
/// (the underscore form since 0.9.113, `CARGO_BIN_EXE_` since 0.9.130); plain `cargo test`
/// falls back to the compile-time path.
fn seed_bin() -> std::path::PathBuf {
    [
        "NEXTEST_BIN_EXE_taphoa_seed",
        "NEXTEST_BIN_EXE_taphoa-seed",
        "CARGO_BIN_EXE_taphoa-seed",
    ]
    .iter()
    .find_map(std::env::var_os)
    .unwrap_or_else(|| env!("CARGO_BIN_EXE_taphoa-seed").into())
    .into()
}

fn run_cli(url: &str, clerk: Option<&str>) -> std::process::Output {
    let mut command = std::process::Command::new(seed_bin());
    command
        .env("DATABASE_URL", url)
        .env_remove("CLERK_SECRET_KEY")
        .env_remove("CLERK_API_URL");
    if let Some(api) = clerk {
        command
            .env("CLERK_SECRET_KEY", KEY)
            .env("CLERK_API_URL", api);
    }
    command.output().expect("run taphoa-seed")
}

#[tokio::test]
#[ignore = "real Postgres required"]
async fn seed_cli_warns_without_key_and_prints_sign_in_emails_with_it() -> anyhow::Result<()> {
    let (api, _shared) = stub().await;
    with_db(|_pool, url| async move {
        let keyless = tokio::task::spawn_blocking({
            let url = url.clone();
            move || run_cli(&url, None)
        })
        .await?;
        assert!(
            keyless.status.success(),
            "{}",
            String::from_utf8_lossy(&keyless.stderr)
        );
        let (out, err) = (
            String::from_utf8_lossy(&keyless.stdout),
            String::from_utf8_lossy(&keyless.stderr),
        );
        assert_eq!(err.matches("cannot sign in").count(), 1, "stderr: {err}");
        assert!(err.contains("CLERK_SECRET_KEY"));
        assert!(
            !out.contains("+clerk_test"),
            "emails printed without a key: {out}"
        );

        let keyed = tokio::task::spawn_blocking({
            let api = api.clone();
            move || run_cli(&url, Some(&api))
        })
        .await?;
        assert!(
            keyed.status.success(),
            "{}",
            String::from_utf8_lossy(&keyed.stderr)
        );
        let (out, err) = (
            String::from_utf8_lossy(&keyed.stdout),
            String::from_utf8_lossy(&keyed.stderr),
        );
        assert!(!err.contains("cannot sign in"), "stderr: {err}");
        for email in all_seed_emails() {
            assert!(out.contains(&email), "stdout lacks {email}: {out}");
        }
        assert!(out.contains("lead") && out.contains("seller") && out.contains("424242"));
        assert!(
            !out.contains(KEY) && !err.contains(KEY),
            "secret key leaked"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn seed_clerk_lookup_escapes_plus_and_reuses_first_match() {
    let (url, shared) = stub().await;
    shared.lock().unwrap().users.extend([
        ("user_first".into(), LEAD_EMAIL.into()),
        ("user_second".into(), LEAD_EMAIL.to_uppercase()),
    ]);
    let id = client(&url).find_or_create(LEAD_EMAIL, "Mẹ").await.unwrap();
    let stub = shared.lock().unwrap();
    assert_eq!(id, "user_first");
    assert_eq!(
        stub.queried,
        [LEAD_EMAIL],
        "`+` must reach Clerk percent-encoded"
    );
    assert_eq!(stub.posts, 0);
}

#[tokio::test]
async fn seed_clerk_gives_up_after_five_retries_without_leaking_the_key() {
    let (url, shared) = stub().await;
    shared.lock().unwrap().throttle = 1_000;
    let error = client(&url)
        .find_or_create(LEAD_EMAIL, "Mẹ")
        .await
        .unwrap_err();
    assert_eq!(shared.lock().unwrap().throttled, 6, "1 request + 5 retries");
    let text = format!("{error:#}");
    assert!(
        text.contains("429") || text.to_lowercase().contains("rate"),
        "{text}"
    );
    assert!(!text.contains(KEY));
}

#[tokio::test]
async fn seed_clerk_create_race_reuses_the_competing_user() {
    let (url, shared) = stub().await;
    shared.lock().unwrap().ghost_on_next_list = true;
    let id = client(&url).find_or_create(LEAD_EMAIL, "Mẹ").await.unwrap();
    let stub = shared.lock().unwrap();
    assert_eq!(id, "user_stub_1");
    assert_eq!(stub.users.len(), 1, "no duplicate user");
    assert_eq!(stub.posts, 1, "the 422 triggered one more lookup");
}

#[tokio::test]
async fn seed_clerk_rejected_key_is_an_error() {
    let (url, shared) = stub().await;
    let error = ClerkUsers::new(&url, "sk_test_wrong")
        .with_min_interval(Duration::ZERO)
        .find_or_create(LEAD_EMAIL, "Mẹ")
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("401"));
    assert_eq!(shared.lock().unwrap().posts, 0);
}

#[tokio::test]
async fn seed_clerk_requests_are_spaced() {
    let (url, _shared) = stub().await;
    let clerk = ClerkUsers::new(&url, KEY).with_min_interval(Duration::from_millis(60));
    let started = Instant::now();
    for email in all_seed_emails().iter().take(3) {
        clerk.find_or_create(email, "x").await.unwrap();
    }
    // Three members need three lookups and three creates: five gaps of 60 ms at least.
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "{:?}",
        started.elapsed()
    );
}
