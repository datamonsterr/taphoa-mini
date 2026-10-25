use anyhow::{Context, Result, bail};
use sqlx::postgres::PgPoolOptions;
use taphoa_api::seed::eval::{self, EvalOptions, EvalReport, EvalStatus};

const USAGE: &str = "usage: taphoa-seed [--profile default|eval] [--reset]\n  --profile eval   build the deterministic eval store \"Tạp hóa Cô Ba\" (business date 2026-10-20)\n  --reset          with --profile eval: delete the eval store and everything it owns, then reseed";

enum Profile {
    Default,
    Eval { reset: bool },
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Profile> {
    let mut args = args.into_iter();
    let (mut profile, mut reset) = (None, false);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--profile" => {
                let Some(value) = args.next() else {
                    bail!("--profile needs a value\n{USAGE}");
                };
                profile = Some(value);
            }
            "--reset" => reset = true,
            other => match other.strip_prefix("--profile=") {
                Some(value) => profile = Some(value.to_string()),
                None => bail!("unknown argument {other}\n{USAGE}"),
            },
        }
    }
    match (profile.as_deref(), reset) {
        (None | Some("default"), false) => Ok(Profile::Default),
        (Some("eval"), reset) => Ok(Profile::Eval { reset }),
        (None | Some("default"), true) => bail!("--reset needs --profile eval\n{USAGE}"),
        (Some(other), _) => bail!("unknown profile {other}\n{USAGE}"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Deterministic credentials and a pinned date: never against production data.
    eval::ensure_not_production(std::env::var("RAILWAY_ENVIRONMENT_NAME").ok().as_deref())?;
    let profile = parse_args(std::env::args().skip(1))?;
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
    match profile {
        Profile::Default => seed_default(&pool).await?,
        Profile::Eval { reset } => {
            let report = eval::run(&pool, EvalOptions { reset }).await?;
            print_eval(&report);
        }
    }
    pool.close().await;
    Ok(())
}

async fn seed_default(pool: &sqlx::PgPool) -> Result<()> {
    let report = taphoa_api::seed::run(pool).await?;
    // Credentials deliberately go to stdout only. Do not add tracing or file output.
    for store in report.stores {
        println!("\n{} ({})", store.name, store.store_id);
        println!("Recovery code: {}", store.recovery_code);
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
    println!(
        "\nRecovery rotates the code. Reruns preserve stored data; printed hints are the original fixture credentials."
    );
    Ok(())
}

fn print_eval(report: &EvalReport) {
    println!("\nEval store: {} ({})", report.name, report.store_id);
    println!(
        "Status: {}",
        match report.status {
            EvalStatus::Created => "created",
            EvalStatus::Existing => "already present, nothing written (use --reset to rebuild)",
            EvalStatus::Reset => "deleted and created again",
        }
    );
    println!("Business date pinned to {}", report.business_date);
    println!("Recovery code: {}", report.recovery_code);
    for member in &report.members {
        println!(
            "  {} [{}]: {} ({}){}{}{}",
            member.display_name,
            member.key,
            member.role,
            member.member_id,
            if member.can_enroll {
                "; can enroll"
            } else {
                ""
            },
            member
                .pin
                .as_ref()
                .map(|pin| format!("; PIN {pin}"))
                .unwrap_or_default(),
            member
                .refresh_token
                .as_ref()
                .map(|token| format!("; refresh token {token}"))
                .unwrap_or_default(),
        );
    }
    println!("Pending invite token: {}", report.invite_token);
    println!(
        "\nThe first POST /v1/auth/refresh rotates a member's refresh token; run --reset to restore the printed ones."
    );
}
