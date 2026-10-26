//! Opening counts follow the historical sales snapshot; two existing purchases
//! have confirmed receipt records. No historical sale is retroactively tracked.
use super::*;

pub(super) async fn seed(tx: &mut Tx<'_>, store: Store) -> Result<()> {
    for n in 0..PRODUCTS.len() / 2 {
        let quantity = match n {
            3 => 0,
            4 => 3,
            5 => 5,
            _ => 20 + n as i32,
        };
        movement(
            tx,
            store,
            n,
            quantity,
            "adjustment",
            None,
            n as u64,
            store.now,
        )
        .await?;
    }
    for (index, offset) in [0_u64, 4].into_iter().enumerate() {
        let id = store.id(31, index as u64);
        let at = store.now + Duration::microseconds(index as i64 + 1);
        let expense = store.id(24, offset);
        let total: i64 = sqlx::query_scalar("SELECT amount FROM expenses WHERE id=$1")
            .bind(expense)
            .fetch_one(&mut **tx)
            .await?;
        sqlx::query("INSERT INTO receipts(id,store_id,member_id,image_id,status,ocr_text,parser,total,expense_id,request_hash,created_at,confirmed_at,updated_at) VALUES($1,$2,$3,$4,'confirmed','Hóa đơn nhập hàng mẫu','fallback',$5,$6,$7,$8,$8,$8)")
            .bind(id).bind(store.store_id()).bind(store.id(1,0)).bind(store.id(13,offset)).bind(total).bind(expense).bind(digest(&id.to_string())).bind(at).execute(&mut **tx).await?;
        for (n, product) in PRODUCTS.iter().enumerate().take(3) {
            let quantity = 2 * case_size(n);
            let cost = product.cost * i64::from(quantity);
            sqlx::query("INSERT INTO receipt_lines(id,receipt_id,store_id,position,raw_text,product_name,quantity,cost,product_id,match_confidence) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,1)")
                .bind(store.id(32,index as u64*3+n as u64)).bind(id).bind(store.store_id()).bind(n as i32).bind(product.name).bind(quantity).bind(cost).bind(store.id(5,n as u64)).execute(&mut **tx).await?;
            movement(
                tx,
                store,
                n,
                quantity,
                "receipt",
                Some(id),
                100 + index as u64 * 3 + n as u64,
                at,
            )
            .await?;
        }
        crate::events::emit(
            tx,
            crate::events::Event {
                store_id: store.store_id(),
                actor: Some((store.id(1, 0), "seed_session".into())),
                typ: "receipt.confirmed",
                version: 1,
                data: json!({"receipt_id":id,"expense_id":expense,"total":total,"line_count":3}),
                change: None,
            },
        )
        .await?;
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn movement(
    tx: &mut Tx<'_>,
    store: Store,
    n: usize,
    delta: i32,
    reason: &'static str,
    reference: Option<Uuid>,
    key: u64,
    at: DateTime<Utc>,
) -> Result<()> {
    let product = store.id(5, n as u64);
    let quantity:i32=sqlx::query_scalar("UPDATE products SET stock_quantity=coalesce(stock_quantity,0)+$2 WHERE id=$1 RETURNING stock_quantity").bind(product).bind(delta).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO stock_movements(id,store_id,product_id,delta,quantity_after,reason,ref_id,member_id,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(store.id(30,key)).bind(store.store_id()).bind(product).bind(delta).bind(quantity).bind(reason).bind(reference).bind(store.id(1,0)).bind((reason=="adjustment").then_some("Kiểm kho ban đầu")).bind(at).execute(&mut **tx).await?;
    crate::events::emit(
        tx,
        crate::events::Event {
            store_id: store.store_id(),
            actor: Some((store.id(1, 0), "seed_session".into())),
            typ: "stock.changed",
            version: 1,
            data: json!({"product_id":product,"stock_quantity":quantity,"reason":reason}),
            change: Some(("product", product, "upsert")),
        },
    )
    .await?;
    Ok(())
}
