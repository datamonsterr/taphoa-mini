use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;

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
    let report = taphoa_api::seed::run(&pool).await?;
    // Credentials deliberately go to stdout only. Do not add tracing or file output.
    for store in report.stores {
        println!("\n{} ({})", store.name, store.store_id);
        for member in store.members {
            println!(
                "  {}: {} ({}){}{}",
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
                    .unwrap_or_default()
            );
        }
        println!(
            "Ready invite token (pending at first seed): {}",
            store.invite_token_hint
        );
    }
    println!("\nReruns preserve stored data; printed hints are the original fixture credentials.");
    pool.close().await;
    Ok(())
}
