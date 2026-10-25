//! Writes a generated [`Dataset`] in the caller's transaction, and deletes it again.
//!
//! Identity is isolated in [`insert_identity`]: store credentials, members, sessions and invites.
//! Everything else refers to members by id only (`sales.session_id` stays NULL).
use super::build::{T_EMBEDDING, id};
use super::model::*;
use crate::seed::{digest, password_hash, vector};
use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

/// Multi-row INSERT in chunks that stay under the 65 535 bind-parameter limit.
macro_rules! bulk {
    ($tx:expr, $head:literal, $cols:expr, $rows:expr, |$b:ident, $r:ident| $body:block) => {{
        let rows = $rows;
        for chunk in rows.chunks(60_000 / $cols) {
            let mut q = QueryBuilder::<Postgres>::new($head);
            q.push_values(chunk, |mut $b, $r| $body);
            q.build().execute(&mut **$tx).await?;
        }
    }};
}

/// An event destined for `outbox_events`. Rows are written already published: nothing relays them.
struct Outbox {
    typ: &'static str,
    at: DateTime<Utc>,
    actor: Uuid,
    data: Value,
    cursor: Option<String>,
}

fn lead(ds: &Dataset) -> Uuid {
    ds.identity
        .members
        .iter()
        .find(|m| m.role == "lead")
        .expect("the eval store has a lead")
        .id
}

fn hash(row_id: Uuid) -> Vec<u8> {
    digest(&row_id.to_string())
}

pub(super) async fn insert_all(tx: &mut Tx<'_>, ds: &Dataset) -> Result<()> {
    let mut outbox = Vec::new();
    insert_identity(tx, ds, &mut outbox).await?;
    insert_catalog(tx, ds, &mut outbox).await?;
    insert_purchasing(tx, ds, &mut outbox).await?;
    insert_sales(tx, ds, &mut outbox).await?;
    // TODO(X5): customers with current and overdue debt, credit sales and repayments. The
    // customer and debt tables do not exist on this branch; task T7 adds the fixtures here
    // once epic X5 is on main (see "Not built" in packages/eval/STORE.md).
    flush_outbox(tx, ds, outbox).await
}

/// Store row with its credentials, members with PINs, sessions and invites, plus their change
/// feed entries. Epic X1 replaces this with Clerk users (`members.clerk_user_id`, no sessions).
async fn insert_identity(tx: &mut Tx<'_>, ds: &Dataset, outbox: &mut Vec<Outbox>) -> Result<()> {
    let store = &ds.store;
    let normalized = ds.identity.recovery_code.replace('-', "");
    let salt = store.id.to_string();
    let pins: Vec<(Uuid, &'static str)> = ds
        .identity
        .members
        .iter()
        .filter_map(|m| m.pin.map(|pin| (m.id, pin)))
        .collect();
    let lookup = digest(&normalized);
    let (recovery_hash, pin_hashes) = tokio::task::spawn_blocking(move || -> Result<_> {
        let recovery = password_hash(&normalized, &salt)?;
        let mut hashes = BTreeMap::new();
        for (member, pin) in pins {
            hashes.insert(member, password_hash(pin, &format!("{salt}/pin/{member}"))?);
        }
        Ok((recovery, hashes))
    })
    .await
    .context("join credential hashing")??;
    sqlx::query("INSERT INTO stores (id,name,bank_bin,bank_short_name,bank_account_number,bank_account_name,margin_threshold_pct,low_stock_threshold,recovery_code_hash,recovery_code_lookup,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)")
        .bind(store.id).bind(store.name).bind(store.bank_bin).bind(store.bank_short_name)
        .bind(store.bank_account_number).bind(store.bank_account_name).bind(store.margin_threshold_pct)
        .bind(store.low_stock_threshold).bind(recovery_hash).bind(lookup).bind(store.created_at)
        .execute(&mut **tx).await?;
    // Credentials never expire on the wall clock: the pinned date, not today's, drives the eval.
    let never = Utc
        .with_ymd_and_hms(2030, 1, 1, 0, 0, 0)
        .single()
        .expect("valid date");
    for m in &ds.identity.members {
        sqlx::query("INSERT INTO members (id,store_id,display_name,role,can_enroll,pin_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)")
            .bind(m.id).bind(store.id).bind(m.name).bind(m.role).bind(m.can_enroll)
            .bind(pin_hashes.get(&m.id)).bind(m.created_at)
            .execute(&mut **tx).await?;
        if let Some(s) = &m.session {
            sqlx::query("INSERT INTO sessions (id,store_id,member_id,device_name,platform,app_version,refresh_token_hash,expires_at,created_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,'1.0.0-eval',$6,$7,$8,$9)")
                .bind(s.id).bind(store.id).bind(m.id).bind(s.device).bind(s.platform)
                .bind(digest(s.refresh_token)).bind(never).bind(m.created_at).bind(ds.now)
                .execute(&mut **tx).await?;
        }
    }
    for i in &ds.identity.invites {
        sqlx::query("INSERT INTO invites (id,store_id,token_hash,role,can_enroll,created_by,expires_at,used_at,used_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(i.id).bind(store.id).bind(digest(&i.token)).bind(i.role).bind(i.can_enroll)
            .bind(i.created_by).bind(never).bind(i.used_at).bind(i.used_by).bind(i.created_at)
            .execute(&mut **tx).await?;
    }
    for m in &ds.identity.members {
        change(
            tx,
            ds,
            outbox,
            "member",
            m.id,
            m.created_at,
            "member.changed",
            json!({"member_id":m.id,"change":"joined"}),
        )
        .await?;
    }
    change(
        tx,
        ds,
        outbox,
        "store",
        store.id,
        store.created_at,
        "store.changed",
        json!({"fields":["name","bank_bin","margin_threshold_pct"]}),
    )
    .await
}

/// One change feed row (for the phone replica) and its published event.
#[allow(clippy::too_many_arguments)]
async fn change(
    tx: &mut Tx<'_>,
    ds: &Dataset,
    outbox: &mut Vec<Outbox>,
    entity: &'static str,
    entity_id: Uuid,
    at: DateTime<Utc>,
    typ: &'static str,
    data: Value,
) -> Result<()> {
    // Eight-byte big-endian seq encoded as unpadded base64url, matching sync cursors.
    let cursor: String = sqlx::query_scalar("INSERT INTO change_log (store_id,entity,entity_id,op,created_at) VALUES ($1,$2,$3,'upsert',$4) RETURNING rtrim(translate(encode(int8send(seq),'base64'),'+/','-_'),'=')")
        .bind(ds.store.id).bind(entity).bind(entity_id).bind(at)
        .fetch_one(&mut **tx).await?;
    outbox.push(Outbox {
        typ,
        at,
        actor: lead(ds),
        data,
        cursor: Some(cursor),
    });
    Ok(())
}

async fn insert_catalog(tx: &mut Tx<'_>, ds: &Dataset, outbox: &mut Vec<Outbox>) -> Result<()> {
    let store = ds.store.id;
    bulk!(
        tx,
        "INSERT INTO categories (id,store_id,name,created_at) ",
        4,
        &ds.categories,
        |b, c| {
            b.push_bind(c.id)
                .push_bind(store)
                .push_bind(c.name)
                .push_bind(c.created_at);
        }
    );
    bulk!(
        tx,
        "INSERT INTO images (id,store_id,object_key,content_type,byte_size,purpose,width,height,uploaded_by,created_at) ",
        10,
        &ds.images,
        |b, i| {
            b.push_bind(i.id)
                .push_bind(store)
                .push_bind(&i.object_key)
                .push_bind("image/jpeg")
                .push_bind(4096_i64)
                .push_bind(i.purpose)
                .push_bind(640_i32)
                .push_bind(480_i32)
                .push_bind(i.uploaded_by)
                .push_bind(i.created_at);
        }
    );
    bulk!(
        tx,
        "INSERT INTO products (id,store_id,name,base_unit,price,cost_price,barcode,category_id,request_hash,created_by,created_at,updated_at,stock_quantity,low_stock_threshold) ",
        14,
        &ds.products,
        |b, p| {
            b.push_bind(p.id)
                .push_bind(store)
                .push_bind(p.name)
                .push_bind(p.base_unit)
                .push_bind(p.price)
                .push_bind(p.cost)
                .push_bind(&p.barcode)
                .push_bind(p.category)
                .push_bind(hash(p.id))
                .push_bind(p.created_by)
                .push_bind(p.created_at)
                .push_bind(p.updated_at)
                .push_bind(p.stock)
                .push_bind(p.threshold);
        }
    );
    bulk!(
        tx,
        "INSERT INTO product_units (id,store_id,product_id,name,quantity_in_base,price) ",
        6,
        &ds.units,
        |b, u| {
            b.push_bind(u.id)
                .push_bind(store)
                .push_bind(u.product)
                .push_bind(u.name)
                .push_bind(u.quantity_in_base)
                .push_bind(u.price);
        }
    );
    bulk!(
        tx,
        "INSERT INTO product_images (product_id,image_id,position,created_at) ",
        4,
        &ds.product_images,
        |b, r| {
            b.push_bind(r.product)
                .push_bind(r.image)
                .push_bind(r.position)
                .push_bind(r.created_at);
        }
    );
    // One unit-norm embedding per reference photo (pseudo-random, keyed by the photo id).
    let ids: Vec<Uuid> = (0..ds.product_images.len())
        .map(|n| id(T_EMBEDDING, n as u64))
        .collect();
    let products: Vec<Uuid> = ds.product_images.iter().map(|r| r.product).collect();
    let images: Vec<Uuid> = ds.product_images.iter().map(|r| r.image).collect();
    let embeddings: Vec<String> = ds.product_images.iter().map(|r| vector(r.image)).collect();
    let created: Vec<DateTime<Utc>> = ds.product_images.iter().map(|r| r.created_at).collect();
    sqlx::query("INSERT INTO product_embeddings (id,store_id,product_id,image_id,model,embedding,created_at) SELECT t.id,$1,t.product_id,t.image_id,'dinov2-vits14-onnx@1',t.embedding::vector,t.created_at FROM unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::text[],$6::timestamptz[]) AS t(id,product_id,image_id,embedding,created_at)")
        .bind(store).bind(ids).bind(products).bind(images).bind(embeddings).bind(created)
        .execute(&mut **tx).await?;
    bulk!(
        tx,
        "INSERT INTO price_history (id,store_id,product_id,unit_id,field,old_value,new_value,source,changed_by,changed_at) ",
        10,
        &ds.price_history,
        |b, h| {
            b.push_bind(h.id)
                .push_bind(store)
                .push_bind(h.product)
                .push_bind(h.unit)
                .push_bind(h.field)
                .push_bind(h.old)
                .push_bind(h.new)
                .push_bind(h.source)
                .push_bind(h.changed_by)
                .push_bind(h.changed_at);
        }
    );
    for c in &ds.categories {
        change(
            tx,
            ds,
            outbox,
            "category",
            c.id,
            c.created_at,
            "catalog.changed",
            json!({"entity":"category","ids":[c.id]}),
        )
        .await?;
    }
    for p in &ds.products {
        change(
            tx,
            ds,
            outbox,
            "product",
            p.id,
            p.created_at,
            "catalog.changed",
            json!({"entity":"product","ids":[p.id]}),
        )
        .await?;
    }
    Ok(())
}

async fn insert_purchasing(tx: &mut Tx<'_>, ds: &Dataset, outbox: &mut Vec<Outbox>) -> Result<()> {
    let store = ds.store.id;
    bulk!(
        tx,
        "INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,image_id,note,request_hash,created_at,updated_at) ",
        13,
        &ds.expenses,
        |b, e| {
            b.push_bind(e.id)
                .push_bind(store)
                .push_bind(e.member)
                .push_bind(e.spent_at)
                .push_bind(e.date)
                .push_bind(e.amount)
                .push_bind(e.category)
                .push_bind(e.paid_with)
                .push_bind(e.image)
                .push_bind(&e.note)
                .push_bind(hash(e.id))
                .push_bind(e.spent_at)
                .push_bind(e.spent_at);
        }
    );
    bulk!(
        tx,
        "INSERT INTO purchase_lines (id,store_id,expense_id,product_id,quantity,unit_cost,base_unit_cost) ",
        7,
        &ds.purchase_lines,
        |b, p| {
            b.push_bind(p.id)
                .push_bind(store)
                .push_bind(p.expense)
                .push_bind(p.product)
                .push_bind(p.quantity)
                .push_bind(p.unit_cost)
                .push_bind(p.unit_cost);
        }
    );
    bulk!(
        tx,
        "INSERT INTO receipts (id,store_id,member_id,image_id,status,ocr_text,parser,model,timings,total,expense_id,request_hash,created_at,confirmed_at,updated_at) ",
        15,
        &ds.receipts,
        |b, r| {
            b.push_bind(r.id)
                .push_bind(store)
                .push_bind(r.member)
                .push_bind(r.image)
                .push_bind(r.status)
                .push_bind(&r.ocr_text)
                .push_bind(r.parser)
                .push_bind(r.model)
                .push_bind(&r.timings)
                .push_bind(r.total)
                .push_bind(r.expense)
                .push_bind(hash(r.id))
                .push_bind(r.created_at)
                .push_bind(r.confirmed_at)
                .push_bind(r.confirmed_at.unwrap_or(r.created_at));
        }
    );
    let candidates = |l: &ReceiptLineRow| -> Value {
        json!(l.candidates.iter().map(|(p, name, probability)| json!({"product_id":p,"name":name,"probability":probability})).collect::<Vec<_>>())
    };
    bulk!(
        tx,
        "INSERT INTO receipt_lines (id,receipt_id,store_id,position,raw_text,product_name,quantity,cost,product_id,match_confidence,candidates) ",
        11,
        &ds.receipt_lines,
        |b, l| {
            b.push_bind(l.id)
                .push_bind(l.receipt)
                .push_bind(store)
                .push_bind(l.position)
                .push_bind(&l.raw_text)
                .push_bind(&l.product_name)
                .push_bind(l.quantity)
                .push_bind(l.cost)
                .push_bind(l.product)
                .push_bind(l.confidence)
                .push_bind(candidates(l));
        }
    );
    bulk!(
        tx,
        "INSERT INTO stock_movements (id,store_id,product_id,delta,quantity_after,reason,ref_id,member_id,note,created_at) ",
        10,
        &ds.movements,
        |b, m| {
            b.push_bind(m.id)
                .push_bind(store)
                .push_bind(m.product)
                .push_bind(m.delta)
                .push_bind(m.after)
                .push_bind(m.reason)
                .push_bind(m.ref_id)
                .push_bind(m.member)
                .push_bind(m.note)
                .push_bind(m.at);
        }
    );
    for a in &ds.alerts {
        sqlx::query("INSERT INTO margin_alerts (id,store_id,product_id,expense_id,cost_price,selling_price,margin_pct,suggested_price,status,resolved_by,resolved_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::float8::numeric,$8,$9,$10,$11,$12)")
            .bind(a.id).bind(store).bind(a.product).bind(a.expense).bind(a.cost).bind(a.price)
            .bind(a.margin_pct).bind(a.suggested).bind(a.status).bind(a.resolved_by).bind(a.resolved_at)
            .bind(a.created_at)
            .execute(&mut **tx).await?;
        outbox.push(Outbox {
            typ: "alert.created",
            at: a.created_at,
            actor: lead(ds),
            data: json!({"alert_id":a.id,"product_id":a.product,"cost_price":a.cost,"selling_price":a.price,"margin_pct":a.margin_pct,"suggested_price":a.suggested}),
            cursor: None,
        });
        if let Some(at) = a.resolved_at {
            outbox.push(Outbox {
                typ: "alert.resolved",
                at,
                actor: lead(ds),
                data: json!({"alert_id":a.id,"status":a.status,"new_price":null}),
                cursor: None,
            });
        }
    }
    for e in &ds.expenses {
        outbox.push(Outbox {
            typ: "expense.created",
            at: e.spent_at,
            actor: e.member,
            data: json!({"expense_id":e.id,"amount":e.amount,"category":e.category,"business_date":e.date}),
            cursor: None,
        });
    }
    for r in ds.receipts.iter().filter(|r| r.status == "confirmed") {
        let lines = ds
            .receipt_lines
            .iter()
            .filter(|l| l.receipt == r.id)
            .count();
        outbox.push(Outbox {
            typ: "receipt.confirmed",
            at: r.confirmed_at.expect("confirmed receipts have a time"),
            actor: r.member,
            data: json!({"receipt_id":r.id,"expense_id":r.expense,"total":r.total,"line_count":lines}),
            cursor: None,
        });
    }
    Ok(())
}

async fn insert_sales(tx: &mut Tx<'_>, ds: &Dataset, outbox: &mut Vec<Outbox>) -> Result<()> {
    let store = ds.store.id;
    // The scans were made against the catalog as it stands after seeding.
    let catalog_version: i64 =
        sqlx::query_scalar("SELECT max(seq) FROM change_log WHERE store_id=$1")
            .bind(store)
            .fetch_one(&mut **tx)
            .await?;
    let timings = json!({"segment":120,"embed":25,"search":5,"total":150});
    bulk!(
        tx,
        "INSERT INTO scans (id,store_id,image_id,member_id,mode,purpose,segmenter,embedder,catalog_version,timings,created_at) ",
        11,
        &ds.scans,
        |b, s| {
            b.push_bind(s.id)
                .push_bind(store)
                .push_bind(s.image)
                .push_bind(s.member)
                .push_bind(if s.multi { "multi" } else { "single" })
                .push_bind("checkout")
                .push_bind("sam-vit-b-onnx@1")
                .push_bind("dinov2-vits14-onnx@1")
                .push_bind(catalog_version)
                .push_bind(&timings)
                .push_bind(s.created_at);
        }
    );
    bulk!(
        tx,
        "INSERT INTO detections (id,store_id,scan_id,position,bbox,score,area,match,candidates) ",
        9,
        &ds.detections,
        |b, d| {
            b.push_bind(d.id)
                .push_bind(store)
                .push_bind(d.scan)
                .push_bind(d.position)
                .push_bind(vec![10_f32 + f32::from(d.position) * 130., 20., 100., 120.])
                .push_bind(0.95_f32)
                .push_bind(12_000_i32)
                .push_bind(d.matched)
                .push_bind(json!(
                    d.candidates
                        .iter()
                        .map(|(p, s)| json!({"product_id":p,"similarity":s}))
                        .collect::<Vec<_>>()
                ));
        }
    );
    bulk!(
        tx,
        "INSERT INTO sales (id,store_id,code,member_id,sold_at,received_at,business_date,payment_method,cash_received,total,vietqr_memo,status,void_reason,voided_by,voided_at,request_hash) ",
        16,
        &ds.sales,
        |b, s| {
            b.push_bind(s.id)
                .push_bind(store)
                .push_bind(&s.code)
                .push_bind(s.member)
                .push_bind(s.sold_at)
                .push_bind(s.sold_at)
                .push_bind(s.date)
                .push_bind(if s.cash { "cash" } else { "transfer" })
                .push_bind(s.cash_received)
                .push_bind(s.total)
                .push_bind(&s.memo)
                .push_bind(if s.void.is_some() {
                    "voided"
                } else {
                    "completed"
                })
                .push_bind(s.void.as_ref().map(|v| v.reason))
                .push_bind(s.void.as_ref().map(|v| v.by))
                .push_bind(s.void.as_ref().map(|v| v.at))
                .push_bind(hash(s.id));
        }
    );
    bulk!(
        tx,
        "INSERT INTO sale_lines (id,store_id,sale_id,position,product_id,unit_id,source,quantity,unit_price,quantity_in_base,manual_label,detection_id,suggested_product_id,price_mismatch,review_status,review_reason,review_action,review_product_id,reviewed_by,reviewed_at) ",
        20,
        &ds.sale_lines,
        |b, l| {
            let r = l.review.as_ref();
            b.push_bind(l.id)
                .push_bind(store)
                .push_bind(l.sale)
                .push_bind(l.position)
                .push_bind(l.product)
                .push_bind(l.unit)
                .push_bind(l.source)
                .push_bind(l.quantity)
                .push_bind(l.unit_price)
                .push_bind(l.quantity_in_base)
                .push_bind(l.label)
                .push_bind(l.detection)
                .push_bind(l.suggested)
                .push_bind(l.mismatch)
                .push_bind(r.map(|r| r.status))
                .push_bind(r.map(|r| r.reason))
                .push_bind(r.and_then(|r| r.action))
                .push_bind(r.and_then(|r| r.product))
                .push_bind(r.and_then(|r| r.by))
                .push_bind(r.and_then(|r| r.at));
        }
    );
    bulk!(
        tx,
        "INSERT INTO sale_scans (sale_id,scan_id) ",
        2,
        &ds.scans,
        |b, s| {
            b.push_bind(s.sale).push_bind(s.id);
        }
    );
    bulk!(
        tx,
        "INSERT INTO day_closes (store_id,business_date,opening_float,cash_sales,cash_refunds,cash_expenses,expected_cash,counted_cash,transfer_revenue,note,closed_by,closed_at) ",
        12,
        &ds.day_closes,
        |b, d| {
            b.push_bind(store)
                .push_bind(d.date)
                .push_bind(d.opening_float)
                .push_bind(d.cash_sales)
                .push_bind(d.cash_refunds)
                .push_bind(d.cash_expenses)
                .push_bind(d.expected_cash)
                .push_bind(d.counted_cash)
                .push_bind(d.transfer_revenue)
                .push_bind(d.note)
                .push_bind(d.closed_by)
                .push_bind(d.closed_at);
        }
    );
    let line_count: BTreeMap<Uuid, usize> =
        ds.sale_lines.iter().fold(BTreeMap::new(), |mut m, l| {
            *m.entry(l.sale).or_default() += 1;
            m
        });
    let sale_of: BTreeMap<Uuid, &SaleRow> = ds.sales.iter().map(|s| (s.id, s)).collect();
    for s in &ds.sales {
        outbox.push(Outbox {
            typ: "sale.created",
            at: s.sold_at,
            actor: s.member,
            data: json!({"sale_id":s.id,"code":s.code,"total":s.total,"payment_method":if s.cash {"cash"} else {"transfer"},"member_id":s.member,"business_date":s.date,"line_count":line_count[&s.id]}),
            cursor: None,
        });
        if let Some(v) = &s.void {
            outbox.push(Outbox {
                typ: "sale.voided",
                at: v.at,
                actor: v.by,
                data: json!({"sale_id":s.id,"reason":v.reason,"voided_by":v.by,"total":s.total}),
                cursor: None,
            });
        }
    }
    for l in ds.sale_lines.iter().filter(|l| l.review.is_some()) {
        let s = sale_of[&l.sale];
        let reason = l.review.as_ref().map_or("", |r| r.reason);
        outbox.push(Outbox {
            typ: "review.line_flagged",
            at: s.sold_at,
            actor: s.member,
            data: json!({"line_id":l.id,"sale_id":l.sale,"reason":reason,"unit_price":l.unit_price}),
            cursor: None,
        });
    }
    Ok(())
}

async fn flush_outbox(tx: &mut Tx<'_>, ds: &Dataset, mut events: Vec<Outbox>) -> Result<()> {
    events.sort_by_key(|e| (e.at, e.typ));
    let store = ds.store.id;
    bulk!(
        tx,
        "INSERT INTO outbox_events (store_id,type,payload,created_at,published_at) ",
        5,
        &events,
        |b, e| {
            let mut payload = json!({
                "id": "evt_pending", "type": e.typ, "version": 1, "store_id": store,
                "occurred_at": e.at.with_timezone(&Ho_Chi_Minh).to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
                "actor": {"member_id": e.actor, "session_id": null}, "data": e.data,
            });
            if let Some(cursor) = &e.cursor {
                payload["cursor"] = json!(cursor);
            }
            b.push_bind(store)
                .push_bind(e.typ)
                .push_bind(payload)
                .push_bind(e.at)
                .push_bind(e.at);
        }
    );
    // The id is database-generated; the envelope carries it.
    sqlx::query("UPDATE outbox_events SET payload = jsonb_set(payload, '{id}', to_jsonb('evt_' || lpad(id::text, 15, '0'))) WHERE store_id = $1")
        .bind(store)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Delete the eval store and every row that belongs to it. Several foreign keys do not cascade
/// (members, products, images, units), so children go first, in dependency order, and a cascade
/// from `stores` takes care of the rest. A plain `DELETE FROM stores` fails: it removes
/// `images` before `product_images`, which references them without a cascade.
///
/// TODO(X5): `debt_entries.sale_id` and `debt_entries.member_id` do not cascade either, so the
/// debt fixtures must be deleted (`debt_entries`, then `customers`) before `sales`.
pub(super) async fn delete_store(tx: &mut Tx<'_>, store: Uuid) -> Result<()> {
    for sql in [
        // sale_lines, sale_scans cascade from sales
        "DELETE FROM sales WHERE store_id=$1",
        // detections cascade from scans
        "DELETE FROM scans WHERE store_id=$1",
        "DELETE FROM purchase_lines WHERE store_id=$1",
        // receipt_lines and receipt_requests cascade from receipts
        "DELETE FROM receipts WHERE store_id=$1",
        "DELETE FROM expenses WHERE store_id=$1",
        // stock_adjustment_requests cascade from stock_movements
        "DELETE FROM stock_movements WHERE store_id=$1",
        "DELETE FROM margin_alerts WHERE store_id=$1",
        "DELETE FROM price_history WHERE store_id=$1",
        "DELETE FROM product_embeddings WHERE store_id=$1",
        "DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE store_id=$1)",
        "DELETE FROM products WHERE store_id=$1",
        "DELETE FROM images WHERE store_id=$1",
        "DELETE FROM day_closes WHERE store_id=$1",
        "DELETE FROM outbox_events WHERE store_id=$1",
        "DELETE FROM change_log WHERE store_id=$1",
    ] {
        sqlx::query(sql)
            .bind(store)
            .execute(&mut **tx)
            .await
            .with_context(|| sql.to_string())?;
    }
    delete_identity(tx, store).await?;
    // categories and the remaining store_id tables cascade from the store.
    sqlx::query("DELETE FROM stores WHERE id=$1")
        .bind(store)
        .execute(&mut **tx)
        .await
        .context("DELETE FROM stores")?;
    Ok(())
}

/// The counterpart of [`insert_identity`]: everything that references members goes first, so
/// invites and members can follow. Task T7 adapts both functions to the Clerk schema.
async fn delete_identity(tx: &mut Tx<'_>, store: Uuid) -> Result<()> {
    // Sessions cascade from members.
    for sql in [
        "DELETE FROM invites WHERE store_id=$1",
        "DELETE FROM members WHERE store_id=$1",
    ] {
        sqlx::query(sql)
            .bind(store)
            .execute(&mut **tx)
            .await
            .with_context(|| sql.to_string())?;
    }
    Ok(())
}
