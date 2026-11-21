use crate::{
    ApiResult, AppState,
    auth::{Action, Actor},
    model_holder::LoadTiming,
};
use axum::{Json, extract::State};
use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
pub struct WarmResponse {
    sam: LoadTiming,
    dinov2: LoadTiming,
    ocr: LoadTiming,
}

pub async fn warm(State(state): State<AppState>, actor: Actor) -> ApiResult<Json<WarmResponse>> {
    actor.require(Action::Sell)?;
    crate::ratelimit::enforce(
        &state,
        &format!("recognition_warm:{}:{}", actor.store_id, actor.member_id),
        6,
        Duration::from_secs(60),
        "model warm requests",
    )
    .await?;
    let sam = async {
        match &state.models.sam {
            Some(holder) => holder
                .get_with_timing()
                .await
                .map(|(lease, timing)| {
                    (
                        lease.map(|model| {
                            model.clone() as std::sync::Arc<dyn taphoa_recognition::Segmenter>
                        }),
                        timing,
                    )
                })
                .map_err(|_| crate::busy()),
            None => Ok((
                state.model_segmenter().await?.ok_or_else(crate::no_model)?,
                fixed_timing(),
            )),
        }
    };
    let dino = async {
        state
            .embedding_holder()
            .ok_or_else(crate::no_model)?
            .get_with_timing()
            .await
            .map_err(|_| crate::busy())
    };
    let ocr = async {
        match &state.models.ocr {
            Some(holder) => holder
                .get_with_timing()
                .await
                .map(|(lease, timing)| {
                    (
                        lease.map(|model| {
                            model.clone() as std::sync::Arc<dyn taphoa_recognition::ocr::ReceiptOcr>
                        }),
                        timing,
                    )
                })
                .map_err(|_| crate::busy()),
            None => Ok((
                state
                    .model_receipt_ocr()
                    .await?
                    .ok_or_else(crate::no_model)?,
                fixed_timing(),
            )),
        }
    };
    // Keep all leases until every family is ready, including with a very short idle timeout.
    let ((_, sam), (_, dinov2), (_, ocr)) = tokio::try_join!(sam, dino, ocr)?;
    Ok(Json(WarmResponse { sam, dinov2, ocr }))
}
fn fixed_timing() -> LoadTiming {
    LoadTiming {
        load_ms: 0,
        already_loaded: true,
    }
}
