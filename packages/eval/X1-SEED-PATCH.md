# X1 seed patch (apply after epic X1 is on `main`)

Status: ready, not applied. Written on 2026-10-26 against `origin/epic/x1-auth-clerk`
(`seed/clerk.rs`, `seed/mod.rs`, `bin/taphoa_seed.rs`, `migrations/0701_clerk_identity.sql`) and
this branch's eval seed. Delete this file in the PR that applies it.

The eval seed writes its identity in one function, `insert::insert_identity`. With X1 on `main`
that function links the eval members to Clerk test users instead of writing PINs-plus-sessions
logins. Everything else in the eval seed stays.

## What X1 changes in the schema (migration `0701_clerk_identity.sql`)

- `members.clerk_user_id TEXT NOT NULL`, unique per store (`members_store_clerk_user_unique`).
- `sessions` table dropped (so the refresh tokens are gone), `sales.session_id` replaced by
  `sales.clerk_session_id TEXT` (the eval sales leave both NULL, so nothing to change).
- `stores.recovery_code_hash` and `stores.recovery_code_lookup` dropped (no recovery code).
- `members.pin_hash` and `invites` stay, unchanged.
- The migration runs `TRUNCATE stores ... CASCADE`: after it, run `taphoa-seed --profile eval`
  again.

## X1 helpers used (public, in `taphoa_api::seed`)

```rust
pub use clerk::{ClerkUsers, member_email};
// member_email(store_key, member_key) == format!("seed-{store_key}-{member_key}+clerk_test@example.com")
// ClerkUsers::from_env() -> Option<ClerkUsers>      (CLERK_SECRET_KEY, CLERK_API_URL)
// ClerkUsers::find_or_create(&self, email: &str, first_name: &str) -> Result<String>   // Clerk user id
```

Eval emails (store key `eval`; sign-in code `424242`):

| Member | Key    | Email                                     | Clerk user |
| ------ | ------ | ----------------------------------------- | ---------- |
| Cô Ba  | co-ba  | `seed-eval-co-ba+clerk_test@example.com`  | yes        |
| Bé Na  | be-na  | `seed-eval-be-na+clerk_test@example.com`  | yes        |
| Anh Tư | anh-tu | `seed-eval-anh-tu+clerk_test@example.com` | no         |

Anh Tư cannot log in (STORE.md), so he gets no Clerk user and the placeholder
`seed_<member id>` that X1's default seed uses for members without a Clerk client. The harness
`ClerkAuth` (`packages/eval/src/runner/auth.ts`) looks up the first two emails.

## 1. `model.rs` and `build.rs`: login flag instead of session

```rust
// model.rs
pub(super) struct Identity {
    // recovery_code removed
    pub members: Vec<MemberRow>,
    pub invites: Vec<InviteRow>,
}
pub(super) struct MemberRow {
    pub id: Uuid,
    pub key: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    pub can_enroll: bool,
    pub pin: Option<&'static str>,
    /// Linked to a Clerk test user (can sign in).
    pub login: bool,
    pub created_at: DateTime<Utc>,
}
// SessionRow removed. Update the doc comment: "members, PINs and invites".
```

```rust
// catalog.rs: MemberSpec { ..., session: Option<(&str, &str, &str)> } becomes `login: bool`
MemberSpec { key: "co-ba",  name: MEMBER_LEAD,     role: "lead",   can_enroll: true,  pin: Some("1357"), login: true },
MemberSpec { key: "be-na",  name: MEMBER_SELLER,   role: "seller", can_enroll: false, pin: Some("2468"), login: true },
MemberSpec { key: "anh-tu", name: MEMBER_ENROLLER, role: "seller", can_enroll: true,  pin: None,         login: false },
```

```rust
// build.rs, fn identity(): replace the `session: m.session.map(...)` field with
            login: m.login,
// and drop `recovery_code: recovery_code(),` from the returned Identity, the
// `recovery_code()` function, and the `T_SESSION` id table constant if nothing else uses it.
```

Remove the sessions from the id-disjointness test (`ids_are_unique_and_disjoint_from_the_v1_fixtures`
in `tests.rs`: the `filter_map(|m| m.session ...)` block).

## 2. `insert.rs`: `insert_identity` and `delete_identity`

Add to the imports:

```rust
use crate::seed::{ClerkUsers, digest, member_email, password_hash, vector};
```

`insert_all` takes the Clerk ids, resolved before the transaction (see 3):

```rust
pub(super) async fn insert_all(
    tx: &mut Tx<'_>,
    ds: &Dataset,
    clerk_ids: &BTreeMap<Uuid, String>,
) -> Result<()> {
    let mut outbox = Vec::new();
    insert_identity(tx, ds, clerk_ids, &mut outbox).await?;
    // ... unchanged
}

/// Store of the eval seed in the Clerk emails: `seed-eval-<member key>+clerk_test@example.com`.
pub(super) const CLERK_STORE_KEY: &str = "eval";

/// Clerk user id of every member that can sign in (found or created by email). Empty without a
/// Clerk client: the members then keep placeholder ids and cannot sign in.
pub(super) async fn clerk_user_ids(
    clerk: Option<&ClerkUsers>,
    ds: &Dataset,
) -> Result<BTreeMap<Uuid, String>> {
    let mut ids = BTreeMap::new();
    let Some(clerk) = clerk else { return Ok(ids) };
    for m in ds.identity.members.iter().filter(|m| m.login) {
        let email = member_email(CLERK_STORE_KEY, m.key);
        let id = clerk
            .find_or_create(&email, m.name)
            .await
            .with_context(|| format!("Clerk test user for {email}"))?;
        ids.insert(m.id, id);
    }
    Ok(ids)
}
```

`insert_identity`: PIN hashes stay, the recovery code goes, members carry `clerk_user_id`,
sessions are not written. The store insert loses `recovery_code_hash,recovery_code_lookup`
(`$9`, `$10`); `created_at` becomes `$9`.

```rust
/// Store row, members with PINs and Clerk user ids, and invites, plus their change feed entries.
async fn insert_identity(
    tx: &mut Tx<'_>,
    ds: &Dataset,
    clerk_ids: &BTreeMap<Uuid, String>,
    outbox: &mut Vec<Outbox>,
) -> Result<()> {
    let store = &ds.store;
    let salt = store.id.to_string();
    let pins: Vec<(Uuid, &'static str)> = ds
        .identity
        .members
        .iter()
        .filter_map(|m| m.pin.map(|pin| (m.id, pin)))
        .collect();
    let pin_hashes = tokio::task::spawn_blocking(move || -> Result<_> {
        let mut hashes = BTreeMap::new();
        for (member, pin) in pins {
            hashes.insert(member, password_hash(pin, &format!("{salt}/pin/{member}"))?);
        }
        Ok(hashes)
    })
    .await
    .context("join credential hashing")??;
    sqlx::query("INSERT INTO stores (id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct,low_stock_threshold,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)")
        .bind(store.id).bind(store.name).bind(store.bank_bin).bind(store.bank_short_name)
        .bind(store.bank_account_number).bind(store.bank_account_name).bind(store.margin_threshold_pct)
        .bind(store.low_stock_threshold).bind(store.created_at)
        .execute(&mut **tx).await?;
    // Invites never expire on the wall clock: the pinned date, not today's, drives the eval.
    let never = Utc
        .with_ymd_and_hms(2030, 1, 1, 0, 0, 0)
        .single()
        .expect("valid date");
    for m in &ds.identity.members {
        let clerk_user_id = clerk_ids
            .get(&m.id)
            .cloned()
            .unwrap_or_else(|| format!("seed_{}", m.id));
        sqlx::query("INSERT INTO members (id,store_id,display_name,role,can_enroll,pin_hash,clerk_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)")
            .bind(m.id).bind(store.id).bind(m.name).bind(m.role).bind(m.can_enroll)
            .bind(pin_hashes.get(&m.id)).bind(clerk_user_id).bind(m.created_at)
            .execute(&mut **tx).await?;
    }
    // invites loop, the member change() loop and the store change() call: unchanged
    // ...
}

/// Points members of an existing eval store at their Clerk users (a rerun without --reset).
/// Rows that already match change nothing.
pub(super) async fn link_members(
    tx: &mut Tx<'_>,
    ds: &Dataset,
    clerk_ids: &BTreeMap<Uuid, String>,
) -> Result<()> {
    for (member, user) in clerk_ids {
        sqlx::query("UPDATE members SET clerk_user_id=$3 WHERE id=$1 AND store_id=$2 AND clerk_user_id IS DISTINCT FROM $3")
            .bind(member).bind(ds.store.id).bind(user)
            .execute(&mut **tx).await?;
    }
    Ok(())
}
```

`delete_identity` needs no SQL change: `sessions` no longer exists, so the "Sessions cascade from
members" comment goes, and the two `DELETE`s (invites, then members) stay. Clerk users are not
deleted: X1's sweep removes only `e2e-*` users, so the `seed-eval-*` users persist across resets.

```rust
/// The counterpart of [`insert_identity`]: everything that references members goes first, so
/// invites and members can follow.
async fn delete_identity(tx: &mut Tx<'_>, store: Uuid) -> Result<()> {
    for sql in [
        "DELETE FROM invites WHERE store_id=$1",
        "DELETE FROM members WHERE store_id=$1",
    ] {
        // unchanged
    }
}
```

## 3. `eval.rs`: options, run, report

```rust
use crate::seed::ClerkUsers;

#[derive(Clone, Copy, Default)] // no Debug: ClerkUsers holds the secret key
pub struct EvalOptions<'a> {
    pub reset: bool,
    /// Links the members that can sign in to Clerk test users; `None` keeps placeholder ids.
    pub clerk: Option<&'a ClerkUsers>,
}

pub async fn run(pool: &PgPool, options: EvalOptions<'_>) -> Result<EvalReport> {
    let data = build::build();
    // Clerk first: nothing is written to the database when Clerk fails (as in seed::run_with).
    let clerk_ids = insert::clerk_user_ids(options.clerk, &data).await?;
    let mut tx = pool.begin().await.context("begin eval seed transaction")?;
    // ... advisory lock and `exists`, unchanged
    if status != EvalStatus::Existing {
        insert::insert_all(&mut tx, &data, &clerk_ids)
            .await
            .context("seed the eval store")?;
    } else {
        insert::link_members(&mut tx, &data, &clerk_ids)
            .await
            .context("link Clerk users of the eval store")?;
    }
    // ...
}
```

`EvalReport`: remove `recovery_code`; `EvalMember`: remove `refresh_token`, add
`pub email: String` (`member_email(CLERK_STORE_KEY, m.key)`) and
`pub clerk_user_id: Option<String>` (`clerk_ids.get(&m.id).cloned()`); add
`pub clerk_linked: bool` to `EvalReport` (`options.clerk.is_some()`). Update the module doc:
"Identity (store, members, invites) is written by one function".

## 4. `bin/taphoa_seed.rs`

X1's version of the binary has no `--profile`; keep main's argument parsing and add X1's Clerk
client to both profiles:

```rust
use taphoa_api::seed::{ClerkUsers, clerk::TEST_CODE};
// ...
    // CLERK_SECRET_KEY (bearer) and CLERK_API_URL (default https://api.clerk.com).
    let clerk = ClerkUsers::from_env();
    match profile {
        Profile::Default => seed_default(&pool, clerk.as_ref()).await?, // X1: run_with(pool, clerk)
        Profile::Eval { reset } => {
            let report = eval::run(&pool, EvalOptions { reset, clerk: clerk.as_ref() }).await?;
            print_eval(&report);
        }
    }
```

`print_eval`: drop the "Recovery code" line and the refresh-token suffix; print the email for
members with a Clerk user, the sign-in code and a warning without a key:

```rust
    for member in &report.members {
        println!(
            "  {} [{}]: {} ({}){}{}{}",
            member.display_name, member.key, member.role, member.member_id,
            if member.can_enroll { "; can enroll" } else { "" },
            member.pin.as_ref().map(|pin| format!("; PIN {pin}")).unwrap_or_default(),
            if member.clerk_user_id.is_some() { format!("; email {}", member.email) } else { String::new() },
        );
    }
    println!("Pending invite token: {}", report.invite_token);
    if report.clerk_linked {
        println!("\nSign in with an email above and the Clerk test code {TEST_CODE} (no mail is sent).");
    } else {
        eprintln!("\nWARNING: CLERK_SECRET_KEY is not set, so the eval members keep placeholder Clerk ids and the harness cannot mint tokens. Set CLERK_SECRET_KEY and rerun.");
    }
```

## 5. Tests and docs that change with it

- `src/seed/eval/tests.rs`: `store_and_members` asserts `login` instead of `session` (Cô Ba and
  Bé Na `login`, Anh Tư not); drop the refresh-token and recovery-code `need(...)` lines of the
  STORE.md coverage test; add a test that `member_email("eval", "co-ba")` is
  `seed-eval-co-ba+clerk_test@example.com` (and `be-na`).
- `tests/seed_eval.rs`: remove `"sessions"` from the table list (line 14) and the
  `count(*) FROM sessions ... == 2` assertion; add: every member has a non-empty
  `clerk_user_id`, and with `CLERK_SECRET_KEY` unset the ids of the two login members start with
  `seed_`. A Clerk-backed variant can reuse `tests/seed_clerk.rs`'s mock server
  (`ClerkUsers::new(&url, KEY).with_min_interval(Duration::ZERO)`): run the eval seed against it
  and assert that exactly the two emails above were looked up and created, and that a rerun
  reuses them.
- `packages/eval/STORE.md` "Store, members and logins": replace the PIN and session column by
  the Clerk email; drop the recovery code and the refresh-token paragraph (lines 31 to 45); fix
  the "Clerk identity (X1)" bullet at the end.
- `packages/eval/README.md`: the `identities` and `ClerkAuth` text already assumes this change.
- Run: `cargo test -p taphoa-api --lib seed`, `cargo test -p taphoa-api --test seed_eval --
--ignored` (`DATABASE_URL` set), then with `CLERK_SECRET_KEY` from `secrets.env`:
  `taphoa-seed --profile eval --reset`, `pnpm --filter @taphoa/eval run identities`, and
  `pnpm --filter @taphoa/eval test:integration` (oracle snapshots must not change).
- CI needs nothing else: `scripts/ci/eval-ci.sh mode` turns live once a migration contains
  `clerk_user_id`, and the stack step already passes `CLERK_SECRET_KEY` to the seed.
