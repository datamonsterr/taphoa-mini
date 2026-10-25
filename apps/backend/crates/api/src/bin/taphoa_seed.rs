use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use taphoa_api::seed::{ClerkUsers, clerk::TEST_CODE};

#[tokio::main]
async fn main() -> Result<()> {
    println!(
        "WARNING: local development only — deterministic credentials, never use in production."
    );
    let url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await?;
    taphoa_api::MIGRATOR
        .run(&pool)
        .await
        .context("run migrations")?;
    // CLERK_SECRET_KEY (bearer) and CLERK_API_URL (default https://api.clerk.com).
    let clerk = ClerkUsers::from_env();
    let report = taphoa_api::seed::run_with(&pool, clerk.as_ref()).await?;
    // Credentials deliberately go to stdout only. Do not add tracing or file output.
    for store in report.stores {
        println!("\n{} ({})", store.name, store.store_id);
        for member in store.members {
            println!(
                "  {}: {} ({}){}{}{}",
                member.display_name,
                member.role,
                member.member_id,
                if member.can_enroll {
                    "; can enroll"
                } else {
                    ""
                },
                member
                    .pin
                    .map(|pin| format!("; PIN {pin}"))
                    .unwrap_or_default(),
                if report.clerk_linked {
                    format!("; email {}", member.email)
                } else {
                    String::new()
                }
            );
        }
        println!(
            "Ready invite token (pending at first seed): {}",
            store.invite_token_hint
        );
    }
    if report.clerk_linked {
        println!(
            "\nSign in with an email above and the Clerk test code {TEST_CODE} (no mail is sent). Reruns reuse the same Clerk users and keep stored data; printed hints are the original fixture credentials."
        );
    } else {
        eprintln!(
            "\nWARNING: CLERK_SECRET_KEY is not set, so seeded members keep placeholder Clerk ids and cannot sign in. Set CLERK_SECRET_KEY (and CLERK_API_URL for a non-default Clerk API) and rerun to create or link their Clerk test users."
        );
        println!(
            "\nReruns preserve stored data; printed hints are the original fixture credentials."
        );
    }
    pool.close().await;
    Ok(())
}
