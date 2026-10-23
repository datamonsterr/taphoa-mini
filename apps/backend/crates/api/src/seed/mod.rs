//! Reproducible, local-development-only fixtures. No object storage writes occur.
//!
//! A store is inserted atomically with its entire 30-day snapshot. Existing fixture
//! store IDs are skipped, even on later dates: reruns preserve counts and edits.
mod catalog;
mod trading;

use anyhow::{Context, Result};
use argon2::{Argon2, password_hash::PasswordHasher};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use catalog::{CATEGORIES, PRODUCTS};

const SEED: &str = "taphoa-mini/local-development/seed-v1";
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
type Tx<'a> = Transaction<'a, Postgres>;

/// Contains local credentials. Deliberately does not implement Debug or Serialize.
pub struct SeedReport {
    pub stores: Vec<StoreReport>,
}

/// Plaintext hints must only be printed to the seed CLI's stdout.
pub struct StoreReport {
    pub store_id: Uuid,
    pub name: String,
    pub recovery_code: String,
    pub members: Vec<MemberReport>,
    pub invite_token_hint: String,
}

pub struct MemberReport {
    pub member_id: Uuid,
    pub display_name: String,
    pub role: String,
    pub can_enroll: bool,
    pub pin: Option<String>,
}

#[derive(Clone, Copy)]
struct Store {
    number: u64,
    today: NaiveDate,
    now: DateTime<Utc>,
}

impl Store {
    // Fixed literal UUID namespace, with disjoint numeric ranges per table/store.
    // These IDs never depend on a clock, entropy, insertion order, or DB sequence.
    fn id(self, table: u16, n: u64) -> Uuid {
        Uuid::from_u128(
            0x7a906e00_0000_4000_8000_000000000000
                | (u128::from(self.number) << 80)
                | (u128::from(table) << 40)
                | u128::from(n),
        )
    }

    fn store_id(self) -> Uuid {
        self.id(0, 0)
    }

    fn name(self) -> &'static str {
        if self.number == 1 {
            "Tạp hóa Cô Ba"
        } else {
            "Cửa hàng Minh Khai"
        }
    }

    fn report(self) -> StoreReport {
        let mut rng = Prng::new(&format!("{SEED}/recovery/{}", self.number));
        let raw = crockford((u128::from(rng.next()) << 64) | u128::from(rng.next()), 16);
        let recovery_code = raw
            .as_bytes()
            .chunks(4)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect::<Vec<_>>()
            .join("-");
        StoreReport {
            store_id: self.store_id(),
            name: self.name().into(),
            recovery_code,
            members: ["Mẹ", "Bà nội", "Con trai", "Cô Lan"]
                .iter()
                .enumerate()
                .map(|(n, name)| MemberReport {
                    member_id: self.id(1, n as u64),
                    display_name: (*name).into(),
                    role: if n == 0 { "lead" } else { "seller" }.into(),
                    can_enroll: n <= 1,
                    pin: (n == 2).then(|| "2468".into()),
                })
                .collect(),
            invite_token_hint: format!(
                "seed_{}",
                hex::encode(digest(&format!("{SEED}/invite/{}/pending", self.number)))
            ),
        }
    }

    fn at(self, date: NaiveDate, hour: u32, minute: u32) -> Result<DateTime<Utc>> {
        let local = date
            .and_hms_opt(hour, minute, 0)
            .context("invalid fixture time")?;
        Ok(Ho_Chi_Minh
            .from_local_datetime(&local)
            .single()
            .context("ambiguous Vietnam business time")?
            .with_timezone(&Utc))
    }
}

/// Seed two stores in separate transactions, serializing competing seed invocations.
/// Dates end on today's Asia/Ho_Chi_Minh business date on the first successful run.
/// Later runs skip existing stores entirely and return the same deterministic hints.
pub async fn run(pool: &PgPool) -> Result<SeedReport> {
    let now = Utc::now();
    let today = now.with_timezone(&Ho_Chi_Minh).date_naive();
    let mut reports = Vec::with_capacity(2);
    for number in 1..=2 {
        let store = Store { number, today, now };
        let report = store.report();
        let mut tx = pool.begin().await.context("begin seed store transaction")?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(7_063_000_i64 + number as i64)
            .execute(&mut *tx)
            .await?;
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM stores WHERE id=$1)")
            .bind(store.store_id())
            .fetch_one(&mut *tx)
            .await?;
        if !exists {
            seed_store(&mut tx, store, &report)
                .await
                .with_context(|| format!("seed store {}", store.name()))?;
        }
        tx.commit().await.context("commit seed store transaction")?;
        reports.push(report);
    }
    Ok(SeedReport { stores: reports })
}

async fn seed_store(tx: &mut Tx<'_>, store: Store, report: &StoreReport) -> Result<()> {
    let normalized = report.recovery_code.replace('-', "");
    let lookup = digest(&normalized);
    let salt = store.store_id().to_string();
    let (recovery_hash, pin_hash) = tokio::task::spawn_blocking(move || -> Result<_> {
        Ok((
            password_hash(&normalized, &salt)?,
            password_hash("2468", &format!("{salt}/pin"))?,
        ))
    })
    .await
    .context("join credential hashing")??;
    let start = store.at(store.today - Duration::days(29), 0, 0)?;
    let bank = store.number == 1;
    sqlx::query("INSERT INTO stores (id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct,recovery_code_hash,recovery_code_lookup,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,20,$7,$8,$9,$9) ON CONFLICT DO NOTHING")
        .bind(store.store_id()).bind(store.name()).bind(bank.then_some("970436"))
        .bind(bank.then_some("Vietcombank")).bind(bank.then_some("0123456789"))
        .bind(bank.then_some("NGUYEN THI BA")).bind(recovery_hash).bind(lookup).bind(start)
        .execute(&mut **tx).await?;
    for (n, member) in report.members.iter().enumerate() {
        sqlx::query("INSERT INTO members (id,store_id,display_name,role,can_enroll,pin_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING")
            .bind(member.member_id).bind(store.store_id()).bind(&member.display_name).bind(&member.role)
            .bind(member.can_enroll).bind(member.pin.as_ref().map(|_| pin_hash.as_str())).bind(start)
            .execute(&mut **tx).await?;
        sqlx::query("INSERT INTO sessions (id,store_id,member_id,device_name,platform,app_version,refresh_token_hash,expires_at,created_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,'1.0.0-seed',$6,$7,$8,$9) ON CONFLICT DO NOTHING")
            .bind(store.id(2,n as u64)).bind(store.store_id()).bind(member.member_id)
            .bind(["Samsung A15 quầy", "iPhone của bà", "Redmi của con", "Máy tính quầy"][n])
            .bind(["android","ios","android","web"][n])
            .bind(digest(&format!("{SEED}/session/{}/{n}",store.number)))
            .bind(store.at(store.today + Duration::days(90),0,0)?).bind(start).bind(store.now)
            .execute(&mut **tx).await?;
        change(tx, store, "member", member.member_id, start).await?;
    }
    change(tx, store, "store", store.store_id(), start).await?;
    for used in [false, true] {
        let token = if used {
            format!("{}/used", report.invite_token_hint)
        } else {
            report.invite_token_hint.clone()
        };
        sqlx::query("INSERT INTO invites (id,store_id,token_hash,role,can_enroll,created_by,expires_at,used_at,used_by,created_at) VALUES ($1,$2,$3,'seller',false,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING")
            .bind(store.id(3,u64::from(used))).bind(store.store_id()).bind(digest(&token)).bind(store.id(1,0))
            .bind(store.at(store.today + Duration::days(7),23,59)?)
            .bind(used.then_some(start + Duration::hours(1))).bind(used.then_some(store.id(1,3))).bind(start)
            .execute(&mut **tx).await?;
    }
    for (n, name) in CATEGORIES.iter().enumerate() {
        let id = store.id(4, n as u64);
        sqlx::query("INSERT INTO categories (id,store_id,name,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(id).bind(store.store_id()).bind(name).bind(start).execute(&mut **tx).await?;
        change(tx, store, "category", id, start).await?;
    }
    for (n, product) in PRODUCTS.iter().enumerate() {
        let id = store.id(5, n as u64);
        let request = json!({"id":id,"name":product.name,"base_unit":product.base_unit,"price":product.price,"cost_price":product.cost,"category_id":store.id(4,product.category as u64)});
        sqlx::query("INSERT INTO products (id,store_id,name,base_unit,price,cost_price,barcode,category_id,request_hash,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT DO NOTHING")
            .bind(id).bind(store.store_id()).bind(product.name).bind(product.base_unit).bind(product.price).bind(product.cost)
            .bind((n%5 != 0).then(|| format!("893{}{:08}",store.number,n)))
            .bind(store.id(4,product.category as u64)).bind(digest(&request.to_string())).bind(store.id(1,0)).bind(start)
            .execute(&mut **tx).await?;
        for (u, name, quantity) in [(0, "lốc", 6_i32), (1, "thùng", case_size(n))] {
            sqlx::query("INSERT INTO product_units (id,store_id,product_id,name,quantity_in_base,price) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
                .bind(store.id(6,n as u64*2+u)).bind(store.store_id()).bind(id).bind(name).bind(quantity)
                .bind(unit_price(n,quantity)).execute(&mut **tx).await?;
        }
        let image = image(tx, store, 10, n as u64, "enrollment", start).await?;
        sqlx::query("INSERT INTO product_images (product_id,image_id,position,created_at) VALUES ($1,$2,0,$3) ON CONFLICT DO NOTHING")
            .bind(id).bind(image).bind(start).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO product_embeddings (id,store_id,product_id,image_id,model,embedding,created_at) VALUES ($1,$2,$3,$4,'dinov2-vits14-onnx@1',$5::text::vector,$6) ON CONFLICT DO NOTHING")
            .bind(store.id(7,n as u64)).bind(store.store_id()).bind(id).bind(image).bind(vector(id)).bind(start)
            .execute(&mut **tx).await?;
        sqlx::query("INSERT INTO price_history (id,store_id,product_id,field,old_value,new_value,source,changed_by,changed_at) VALUES ($1,$2,$3,'price',NULL,$4,'manual',$5,$6) ON CONFLICT DO NOTHING")
            .bind(store.id(8,n as u64)).bind(store.store_id()).bind(id).bind(if n == 1 { product.price - 1000 } else { product.price }).bind(store.id(1,0)).bind(start)
            .execute(&mut **tx).await?;
        change(tx, store, "product", id, start).await?;
    }
    trading::seed(tx, store).await
}

fn password_hash(password: &str, salt_key: &str) -> Result<String> {
    Argon2::default()
        .hash_password_with_salt(password.as_bytes(), &digest(salt_key)[..16])
        .map(|hash| hash.to_string())
        .map_err(|_| anyhow::anyhow!("hash local seed credential"))
}

fn digest(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

fn case_size(product: usize) -> i32 {
    match PRODUCTS[product].category {
        0 => 30,
        1 | 5 => 24,
        _ => 12,
    }
}

fn unit_price(product: usize, quantity: i32) -> i64 {
    PRODUCTS[product].price * i64::from(quantity) - i64::from(quantity) * 500
}

async fn image(
    tx: &mut Tx<'_>,
    store: Store,
    kind: u16,
    n: u64,
    purpose: &str,
    at: DateTime<Utc>,
) -> Result<Uuid> {
    let id = store.id(kind, n);
    sqlx::query("INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose,width,height,uploaded_by,created_at) VALUES ($1,$2,$3,'image/jpeg',4096,$4,640,480,$5,$6) ON CONFLICT DO NOTHING")
        .bind(id).bind(store.store_id()).bind(format!("images/2026/10/{id}.jpg")).bind(purpose).bind(store.id(1,0)).bind(at)
        .execute(&mut **tx).await?;
    Ok(id)
}

async fn change(
    tx: &mut Tx<'_>,
    store: Store,
    entity: &str,
    id: Uuid,
    at: DateTime<Utc>,
) -> Result<()> {
    // Eight-byte big-endian seq encoded as unpadded base64url, matching sync cursors.
    let cursor: String = sqlx::query_scalar("INSERT INTO change_log (store_id,entity,entity_id,op,created_at) VALUES ($1,$2,$3,'upsert',$4) RETURNING rtrim(translate(encode(int8send(seq),'base64'),'+/','-_'),'=')")
        .bind(store.store_id()).bind(entity).bind(id).bind(at).fetch_one(&mut **tx).await?;
    let (kind, data) = match entity {
        "store" => (
            "store.changed",
            json!({"fields":["name","bank_bin","margin_threshold_pct"]}),
        ),
        "member" => ("member.changed", json!({"member_id":id,"change":"joined"})),
        _ => ("catalog.changed", json!({"entity":entity,"ids":[id]})),
    };
    event(tx, store, kind, data, Some(cursor), at).await
}

async fn event(
    tx: &mut Tx<'_>,
    store: Store,
    kind: &str,
    data: Value,
    cursor: Option<String>,
    at: DateTime<Utc>,
) -> Result<()> {
    let id: i64 = sqlx::query_scalar("INSERT INTO outbox_events (store_id,type,payload,created_at) VALUES ($1,$2,'{}',$3) RETURNING id")
        .bind(store.store_id()).bind(kind).bind(at).fetch_one(&mut **tx).await?;
    let actor_member = data
        .get("member_id")
        .cloned()
        .unwrap_or_else(|| json!(store.id(1, 0)));
    let actor_session = if let Some(member) = actor_member
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
    {
        (0..4)
            .find(|n| store.id(1, *n) == member)
            .map(|n| store.id(2, n))
    } else {
        None
    };
    let mut payload = json!({"id":format!("evt_{id:015}"),"type":kind,"version":1,"store_id":store.store_id(),"occurred_at":at.with_timezone(&Ho_Chi_Minh).to_rfc3339(),"actor":{"member_id":actor_member,"session_id":actor_session},"data":data});
    if let Some(cursor) = cursor {
        payload["cursor"] = json!(cursor);
    }
    sqlx::query("UPDATE outbox_events SET payload=$2,published_at=$3 WHERE id=$1")
        .bind(id)
        .bind(payload)
        .bind((id % 211 != 0).then_some(at + Duration::seconds(1)))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

struct Prng(u64);
impl Prng {
    fn new(key: &str) -> Self {
        let mut bytes = [0; 8];
        bytes.copy_from_slice(&Sha256::digest(key.as_bytes())[..8]);
        Self(u64::from_le_bytes(bytes))
    }
    // SplitMix64: stable, tiny, and explicitly unsuitable for real credentials.
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut n = self.0;
        n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
        n ^ (n >> 31)
    }
}

fn crockford(mut n: u128, width: usize) -> String {
    let mut out = vec!['0'; width];
    for c in out.iter_mut().rev() {
        *c = char::from(CROCKFORD[(n & 31) as usize]);
        n >>= 5;
    }
    out.into_iter().collect()
}

fn vector(id: Uuid) -> String {
    let mut rng = Prng::new(&format!("{SEED}/embedding/{id}"));
    let mut values: Vec<f64> = (0..384)
        .map(|_| (rng.next() % 20001) as f64 / 10000.0 - 1.0)
        .collect();
    let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
    for value in &mut values {
        *value /= norm;
    }
    format!(
        "[{}]",
        values
            .iter()
            .map(|v| format!("{v:.9}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::password_hash::PasswordVerifier;

    #[test]
    fn credentials_and_vectors_are_reproducible() {
        let store = Store {
            number: 1,
            today: NaiveDate::from_ymd_opt(2026, 10, 23).unwrap(),
            now: DateTime::from_timestamp(1_792_720_800, 0).unwrap(),
        };
        let first = store.report();
        assert_eq!(first.recovery_code, store.report().recovery_code);
        assert_eq!(first.recovery_code.len(), 19);
        assert!(
            first
                .recovery_code
                .split('-')
                .all(|s| s.len() == 4 && s.bytes().all(|c| CROCKFORD.contains(&c)))
        );
        let normalized = first.recovery_code.replace('-', "");
        let hash = password_hash(&normalized, "fixture salt").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        Argon2::default()
            .verify_password(normalized.as_bytes(), hash.as_str())
            .unwrap();
        let embedding: Vec<f64> = serde_json::from_str(&vector(store.id(5, 0))).unwrap();
        assert_eq!(embedding.len(), 384);
        assert!((embedding.iter().map(|v| v * v).sum::<f64>() - 1.0).abs() < 1e-6);
    }
}
