//! Lead review changes labels and reference images, never recorded sale amounts.
use super::*;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/review/manual-lines", get(list))
        .route("/v1/review/manual-lines/{id}/resolve", post(resolve))
}
#[derive(Deserialize)]
struct Filters {
    status: Option<String>,
}
#[derive(sqlx::FromRow)]
struct CropRow {
    id: Uuid,
    object_key: String,
    content_type: String,
    byte_size: i64,
    width: Option<i32>,
    height: Option<i32>,
}
async fn list(
    State(state): State<AppState>,
    actor: Actor,
    page: PageParams,
    filters: Result<Query<Filters>, QueryRejection>,
) -> ApiResult<Json<Page<Value>>> {
    actor.require(Action::ReviewQueue)?;
    let f = query(filters)?;
    let status = f.status.as_deref().unwrap_or("open");
    if !matches!(status, "open" | "resolved") {
        return Err(ApiError::validation_failed("invalid review status"));
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> =
        page.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut conn = pool(&state)?.acquire().await?;
    let mut rows: Vec<(Uuid, DateTime<Utc>)> = sqlx::query_as("SELECT l.id,s.sold_at FROM sale_lines l JOIN sales s ON s.id=l.sale_id AND s.store_id=l.store_id WHERE l.store_id=$1 AND l.review_status=$2 AND ($3::timestamptz IS NULL OR (s.sold_at,l.id)<($3,$4)) ORDER BY s.sold_at DESC,l.id DESC LIMIT $5")
        .bind(actor.store_id).bind(status).bind(cursor.map(|c| c.0)).bind(cursor.map(|c| c.1)).bind(i64::from(page.limit)+1).fetch_all(&mut *conn).await?;
    let next_cursor = if rows.len() > page.limit as usize {
        rows.pop();
        rows.last()
            .map(|(id, at)| encode_cursor(&(*at, *id)))
            .transpose()
            .map_err(|_| ApiError::internal())?
    } else {
        None
    };
    let mut items = Vec::with_capacity(rows.len());
    for (id, _) in rows {
        items.push(line(&mut conn, &state, actor.store_id, id).await?);
    }
    Ok(Json(Page { items, next_cursor }))
}
async fn line(
    conn: &mut PgConnection,
    state: &AppState,
    store: Uuid,
    id: Uuid,
) -> ApiResult<Value> {
    let (mut value, crop): (Value, Option<Uuid>) = sqlx::query_as("SELECT jsonb_build_object('line_id',l.id,'sale_id',l.sale_id,'sold_at',s.sold_at,'sold_by',s.member_id,'unit_price',l.unit_price,'quantity',l.quantity,'manual_label',l.manual_label,'reason',l.review_reason,'status',l.review_status,'resolution',CASE WHEN l.review_status='resolved' THEN jsonb_build_object('action',l.review_action,'product_id',l.review_product_id,'resolved_by',l.reviewed_by,'resolved_at',l.reviewed_at) ELSE NULL END),d.crop_image_id FROM sale_lines l JOIN sales s ON s.id=l.sale_id AND s.store_id=l.store_id LEFT JOIN detections d ON d.id=l.detection_id AND d.store_id=l.store_id WHERE l.store_id=$1 AND l.id=$2 AND l.review_status IS NOT NULL")
        .bind(store).bind(id).fetch_optional(&mut *conn).await?.ok_or_else(ApiError::not_found)?;
    value["crop_image"] = Value::Null;
    if let Some(crop) = crop {
        let image: Option<CropRow> = sqlx::query_as("SELECT id,object_key,content_type,byte_size,width,height FROM images WHERE store_id=$1 AND id=$2")
            .bind(store).bind(crop).fetch_optional(conn).await?;
        if let Some(row) = image {
            let signed = state
                .storage
                .as_deref()
                .ok_or_else(ApiError::unavailable)?
                .presign_get(&row.object_key, state.image_url_ttl)
                .await
                .map_err(|e| {
                    tracing::error!(%e,"review image presign failed");
                    ApiError::new(
                        axum::http::StatusCode::BAD_GATEWAY,
                        "storage_failure",
                        "storage failure",
                    )
                })?;
            let mut image = json!({"id":row.id,"object_key":row.object_key,"content_type":row.content_type,"byte_size":row.byte_size,"url":signed.url,"url_expires_at":signed.expires_at});
            // Internal crops have no public ImagePurpose enum value.
            if let Some(width) = row.width {
                image["width"] = json!(width);
            }
            if let Some(height) = row.height {
                image["height"] = json!(height);
            }
            value["crop_image"] = image;
        }
    }
    Ok(value)
}
#[derive(Debug, Deserialize)]
struct ResolveInput {
    action: String,
    product_id: Option<Uuid>,
}
impl ResolveInput {
    fn validate(&self) -> ApiResult<()> {
        if !matches!(self.action.as_str(), "link" | "enrolled" | "dismiss")
            || (matches!(self.action.as_str(), "link" | "enrolled") && self.product_id.is_none())
        {
            Err(ApiError::validation_failed(
                "link and enrolled require a product_id and a valid action",
            ))
        } else {
            Ok(())
        }
    }
}
async fn resolve(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ValidJson(input): ValidJson<ResolveInput>,
) -> ApiResult<Json<Value>> {
    actor.require(Action::ReviewQueue)?;
    input.validate()?;
    let id = parse_id(&id)?;
    let mut tx = pool(&state)?.begin().await?;
    let (status, detection): (String,Option<Uuid>) = sqlx::query_as("SELECT review_status,detection_id FROM sale_lines WHERE store_id=$1 AND id=$2 AND review_status IS NOT NULL FOR UPDATE")
        .bind(actor.store_id).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    if status != "open" {
        return Err(ApiError::conflict(
            "already_resolved",
            "line already resolved",
        ));
    }
    if let Some(product) = input.product_id {
        product_exists(&mut tx, actor.store_id, product).await?;
    }
    if input.action == "link" {
        add_reference(
            &mut tx,
            &actor,
            input.product_id.expect("validated product"),
            detection,
        )
        .await?;
    }
    let product = if input.action == "dismiss" {
        None
    } else {
        input.product_id
    };
    sqlx::query("UPDATE sale_lines SET review_status='resolved',review_action=$3,review_product_id=$4,reviewed_by=$5,reviewed_at=now() WHERE store_id=$1 AND id=$2")
        .bind(actor.store_id).bind(id).bind(&input.action).bind(product).bind(actor.member_id).execute(&mut *tx).await?;
    event(
        &mut tx,
        &actor,
        "review.line_resolved",
        json!({"line_id":id,"action":input.action,"product_id":product}),
    )
    .await?;
    let result = line(&mut tx, &state, actor.store_id, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn add_reference(
    conn: &mut PgConnection,
    actor: &Actor,
    product: Uuid,
    detection: Option<Uuid>,
) -> ApiResult<()> {
    let Some(detection) = detection else {
        return Ok(());
    };
    // Serialize reference positions with other resolutions targeting this product.
    sqlx::query("SELECT id FROM products WHERE store_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.store_id)
        .bind(product)
        .execute(&mut *conn)
        .await?;
    // At most five public reference photos. Keep the training label even if all slots are full.
    sqlx::query("INSERT INTO product_images(product_id,image_id,position) SELECT $2,d.crop_image_id,slot.position::smallint FROM detections d JOIN images i ON i.id=d.crop_image_id AND i.store_id=d.store_id CROSS JOIN LATERAL (SELECT n AS position FROM generate_series(0,4) n WHERE NOT EXISTS(SELECT 1 FROM product_images pi WHERE pi.product_id=$2 AND pi.position=n) ORDER BY n LIMIT 1) slot WHERE d.store_id=$1 AND d.id=$3 ON CONFLICT DO NOTHING")
        .bind(actor.store_id).bind(product).bind(detection).execute(&mut *conn).await?;
    sqlx::query("INSERT INTO product_embeddings(store_id,product_id,image_id,detection_id,model,embedding) SELECT d.store_id,$2,d.crop_image_id,d.id,s.embedder,d.embedding FROM detections d JOIN scans s ON s.id=d.scan_id AND s.store_id=d.store_id JOIN images i ON i.id=d.crop_image_id AND i.store_id=d.store_id WHERE d.store_id=$1 AND d.id=$3 AND d.embedding IS NOT NULL AND NOT EXISTS(SELECT 1 FROM product_embeddings e WHERE e.product_id=$2 AND e.detection_id=d.id AND e.model=s.embedder)")
        .bind(actor.store_id).bind(product).bind(detection).execute(&mut *conn).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolution_requires_known_action_and_product() {
        for action in ["link", "enrolled"] {
            assert!(
                ResolveInput {
                    action: action.into(),
                    product_id: None
                }
                .validate()
                .is_err()
            );
            assert!(
                ResolveInput {
                    action: action.into(),
                    product_id: Some(Uuid::now_v7())
                }
                .validate()
                .is_ok()
            );
        }
        assert!(
            ResolveInput {
                action: "dismiss".into(),
                product_id: None
            }
            .validate()
            .is_ok()
        );
        assert!(
            ResolveInput {
                action: "unknown".into(),
                product_id: None
            }
            .validate()
            .is_err()
        );
    }
}
