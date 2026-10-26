use super::{
    CustomerRow, DebtEntryRow,
    aging::{self, Entry},
    db_error, invalid,
};
use crate::{
    ApiError, ApiResult,
    events::{Event, emit},
};
use chrono::NaiveDate;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

/// Store-scoped lock, including archived customers. Acquire all product locks
/// first, this customer lock second, and only then the store lock in events::emit.
/// Sales must call this immediately after stock::lock_products, before any emit.
/// Does not commit; record_entry can safely reacquire the same transaction's lock.
pub(crate) async fn lock_customer(
    tx: &mut PgConnection,
    store_id: Uuid,
    customer_id: Uuid,
) -> ApiResult<CustomerRow> {
    sqlx::query_as("SELECT * FROM customers WHERE store_id=$1 AND id=$2 FOR UPDATE")
        .bind(store_id)
        .bind(customer_id)
        .fetch_optional(tx)
        .await
        .map_err(db_error)?
        .ok_or_else(ApiError::not_found)
}
/// The single ledger writer. Never commits. Lock order: products, customer, store
/// (events::emit). Sales/void callers MUST lock their customer before their first
/// stock or sale event, then call this inside that same transaction.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_entry(
    tx: &mut PgConnection,
    store_id: Uuid,
    customer_id: Uuid,
    kind: &str,
    amount: i64,
    sale_id: Option<Uuid>,
    method: Option<&str>,
    reason: Option<&str>,
    member_id: Uuid,
    business_date: NaiveDate,
    key_hash: Option<&[u8]>,
    request_hash: Option<&[u8]>,
    actor: Option<(Uuid, String)>,
) -> ApiResult<DebtEntryRow> {
    if !match kind {
        "credit_sale" => amount > 0,
        "void" | "repayment" => amount < 0,
        "adjustment" => amount != 0,
        _ => false,
    } || method.is_some_and(|m| !matches!(m, "cash" | "transfer"))
        || (kind == "repayment" && (method.is_none() || amount == i64::MIN))
        || (matches!(kind, "credit_sale" | "void") && sale_id.is_none())
        || reason.is_some_and(|s| !(1..=200).contains(&s.chars().count()))
    {
        return Err(invalid("invalid debt entry"));
    }
    let customer = lock_customer(tx, store_id, customer_id).await?;
    let balance = customer
        .balance
        .checked_add(amount)
        .ok_or_else(|| invalid("balance overflow"))?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM members WHERE store_id=$1 AND id=$2) AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM sales WHERE store_id=$1 AND id=$3))")
        .bind(store_id).bind(member_id).bind(sale_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    if !valid {
        return Err(ApiError::not_found());
    }
    let row:DebtEntryRow=sqlx::query_as("INSERT INTO debt_entries(id,store_id,customer_id,kind,amount,balance_after,sale_id,method,reason,member_id,business_date,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()) RETURNING *")
        .bind(Uuid::now_v7()).bind(store_id).bind(customer_id).bind(kind).bind(amount).bind(balance).bind(sale_id).bind(method).bind(reason).bind(member_id).bind(business_date).bind(key_hash).bind(request_hash).fetch_one(&mut *tx).await.map_err(db_error)?;
    let entries:Vec<Entry>=sqlx::query_as("SELECT id,kind,amount,sale_id,business_date,created_at FROM debt_entries WHERE store_id=$1 AND customer_id=$2")
        .bind(store_id).bind(customer_id).fetch_all(&mut *tx).await.map_err(db_error)?;
    let oldest = if balance > 0 {
        aging::oldest_debt_date(&entries)
    } else {
        None
    };
    sqlx::query("UPDATE customers SET balance=$3,oldest_debt_date=$4,updated_at=clock_timestamp() WHERE store_id=$1 AND id=$2")
        .bind(store_id).bind(customer_id).bind(balance).bind(oldest).execute(&mut *tx).await.map_err(db_error)?;
    let (typ, data) = match kind {
        "repayment" => (
            "debt.repaid",
            json!({"entry_id":row.id,"customer_id":customer_id,"amount":-amount,"method":method,"balance":balance,"business_date":business_date}),
        ),
        "adjustment" => (
            "debt.adjusted",
            json!({"entry_id":row.id,"customer_id":customer_id,"amount":amount,"balance":balance,"business_date":business_date}),
        ),
        _ => (
            "debt.recorded",
            json!({"entry_id":row.id,"customer_id":customer_id,"kind":kind,"amount":amount,"sale_id":sale_id,"balance":balance,"business_date":business_date}),
        ),
    };
    emit(
        tx,
        Event {
            store_id,
            actor: actor.clone(),
            typ,
            version: 1,
            data,
            change: Some(("debt_entry", row.id, "upsert")),
        },
    )
    .await?;
    emit_customer(
        tx,
        store_id,
        actor,
        "customer.updated",
        customer_id,
        balance,
        customer.archived_at.is_some(),
    )
    .await?;
    Ok(row)
}
pub(super) async fn emit_customer(
    tx: &mut PgConnection,
    store_id: Uuid,
    actor: Option<(Uuid, String)>,
    typ: &'static str,
    id: Uuid,
    balance: i64,
    archived: bool,
) -> ApiResult<()> {
    emit(
        tx,
        Event {
            store_id,
            actor,
            typ,
            version: 1,
            data: json!({"customer_id":id,"balance":balance,"archived":archived}),
            change: Some(("customer", id, "upsert")),
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use serde_json::Value;

    fn assert_event_contract(payload: &Value) {
        let doc: Value =
            serde_norway::from_str(include_str!("../../../../../../docs/api/asyncapi.yaml"))
                .unwrap();
        let message = doc["components"]["messages"]
            .as_object()
            .unwrap()
            .values()
            .find(|m| m["name"] == payload["type"])
            .unwrap();
        let root = json!({"$schema":"https://json-schema.org/draft/2020-12/schema","components":doc["components"],"allOf":[message["payload"]]});
        let validator = jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&root)
            .unwrap();
        let errors: Vec<_> = validator
            .iter_errors(payload)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{payload}: {errors:?}");
    }
    #[tokio::test]
    #[ignore = "requires DATABASE_URL and REDIS_URL"]
    async fn writer_credit_void_events_and_caller_rollback() {
        let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
            .await
            .unwrap();
        crate::MIGRATOR.run(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let store: Uuid = sqlx::query_scalar(
            "INSERT INTO stores(name,recovery_code_hash) VALUES('writer','x') RETURNING id",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let member: Uuid = sqlx::query_scalar(
            "INSERT INTO members(store_id,display_name,role) VALUES($1,'Lead','lead') RETURNING id",
        )
        .bind(store)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let customer = Uuid::now_v7();
        sqlx::query("INSERT INTO customers(id,store_id,name,phone,note,request_hash) VALUES($1,$2,'PrivateName','PrivatePhone','PrivateNote','hash')").bind(customer).bind(store).execute(&mut *tx).await.unwrap();
        let sale = Uuid::now_v7();
        sqlx::query("INSERT INTO sales(id,store_id,code,member_id,sold_at,business_date,payment_method,total,credit_amount,customer_id,request_hash) VALUES($1,$2,'writer',$3,now(),current_date,'credit',100,100,$4,'hash')").bind(sale).bind(store).bind(member).bind(customer).execute(&mut *tx).await.unwrap();
        let today = crate::time::business_date(Utc::now());
        let old = today - Duration::days(10);
        assert!(
            record_entry(
                &mut tx,
                store,
                customer,
                "credit_sale",
                100,
                None,
                None,
                None,
                member,
                old,
                None,
                None,
                None
            )
            .await
            .is_err(),
            "sale id is required by debt.recorded contract"
        );
        let credit = record_entry(
            &mut tx,
            store,
            customer,
            "credit_sale",
            100,
            Some(sale),
            None,
            None,
            member,
            old,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(credit.balance_after, 100);
        assert_eq!(
            lock_customer(&mut tx, store, customer)
                .await
                .unwrap()
                .oldest_debt_date,
            Some(old)
        );
        record_entry(
            &mut tx,
            store,
            customer,
            "adjustment",
            50,
            None,
            None,
            Some("opening"),
            member,
            today,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        record_entry(
            &mut tx,
            store,
            customer,
            "repayment",
            -25,
            None,
            Some("cash"),
            None,
            member,
            today,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let void = record_entry(
            &mut tx,
            store,
            customer,
            "void",
            -100,
            Some(sale),
            None,
            None,
            member,
            today,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(void.balance_after, 25);
        let row = lock_customer(&mut tx, store, customer).await.unwrap();
        assert_eq!(row.balance, 25);
        assert_eq!(row.oldest_debt_date, Some(today));
        assert!(
            lock_customer(&mut tx, Uuid::now_v7(), customer)
                .await
                .is_err()
        );
        let payloads: Vec<Value> =
            sqlx::query_scalar("SELECT payload FROM outbox_events WHERE store_id=$1 ORDER BY id")
                .bind(store)
                .fetch_all(&mut *tx)
                .await
                .unwrap();
        assert_eq!(payloads.len(), 8);
        for payload in payloads {
            assert_event_contract(&payload);
            let text = payload.to_string();
            for private in ["PrivateName", "PrivatePhone", "PrivateNote", "reason"] {
                assert!(!text.contains(private));
            }
        }
        tx.rollback().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM debt_entries WHERE store_id=$1")
            .bind(store)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE store_id=$1")
            .bind(store)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
