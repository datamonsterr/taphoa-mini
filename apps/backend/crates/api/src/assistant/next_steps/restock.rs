use super::*;

pub fn run<'a>(db: &'a PgPool, actor: &'a Actor, input: &'a RuleInput) -> RuleFuture<'a> {
    Box::pin(async move {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM products p JOIN stores s ON s.id=p.store_id WHERE p.store_id=$1 AND NOT p.archived AND p.stock_quantity <= COALESCE(p.low_stock_threshold,s.low_stock_threshold)")
            .bind(actor.store_id).fetch_optional(db).await?.unwrap_or(0);
        Ok(if count > 0 {
            vec![
                NextStep::new(
                    "restock",
                    "Nhập thêm hàng",
                    10,
                    None,
                    chat(input, "restock", "Lên danh sách nhập hàng"),
                )
                .counted(count, "sản phẩm sắp hết"),
            ]
        } else {
            vec![]
        })
    })
}
