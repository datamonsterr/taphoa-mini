//! Shared catalog model: request types, validation, row mappings and patch diffing.
use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

pub const NAME_MAX: usize = 120;
pub const UNIT_MAX: usize = 20;
pub const BARCODE_MAX: usize = 64;
pub const CATEGORY_MAX: usize = 40;
pub const MAX_IMAGES: usize = 8;
pub const MAX_LEGACY_IMAGE_IDS: usize = 5;
pub const MIN_REFERENCES: usize = 3;
pub const DUPLICATE_THRESHOLD: f64 = 0.88;

pub fn path_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| ApiError::not_found())
}

fn check_len(value: &str, max: usize, what: &str) -> ApiResult<()> {
    if value.chars().count() > max {
        Err(ApiError::validation_failed(format!("{what} is too long")))
    } else {
        Ok(())
    }
}

pub mod double_option {
    use serde::Deserialize;

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: serde::de::Deserialize<'de>,
        D: serde::de::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProductUnitInput {
    pub id: Uuid,
    pub name: String,
    pub quantity_in_base: i32,
    pub price: i64,
    #[serde(default)]
    pub barcode: Option<String>,
}

impl ProductUnitInput {
    pub fn validate(&self) -> ApiResult<()> {
        if self.quantity_in_base < 2 {
            return Err(ApiError::validation_failed(
                "unit quantity_in_base must be at least 2",
            ));
        }
        if self.price < 0 {
            return Err(ApiError::validation_failed(
                "unit price must not be negative",
            ));
        }
        check_len(&self.name, NAME_MAX, "unit name")?;
        if let Some(barcode) = &self.barcode {
            check_len(barcode, BARCODE_MAX, "unit barcode")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProductReference {
    pub image_id: Uuid,
    pub cutout_image_id: Uuid,
    pub bbox: [f32; 4],
}

pub(crate) fn reference_validation(message: impl Into<String>) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        message,
    )
}

pub(crate) fn validate_bbox(bbox: &[f32; 4]) -> ApiResult<()> {
    if bbox.iter().any(|v| !v.is_finite()) || bbox[2] <= 0. || bbox[3] <= 0. {
        return Err(reference_validation(
            "bbox must be finite with positive width and height",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateProductRequest {
    pub id: Uuid,
    pub price: i64,
    pub image_ids: Option<Vec<Uuid>>,
    pub references: Option<Vec<ProductReference>>,
    #[serde(default)]
    pub name: Option<String>,
    pub base_unit: Option<String>,
    pub cost_price: Option<i64>,
    #[serde(default)]
    pub barcode: Option<String>,
    pub category_id: Option<Uuid>,
    pub units: Option<Vec<ProductUnitInput>>,
    /// Enrolling a flagged manual sale line (F3): the line is resolved as `enrolled`.
    #[serde(default)]
    pub from_manual_line_id: Option<Uuid>,
    #[serde(default)]
    pub force_new: bool,
}

impl CreateProductRequest {
    pub fn parse(value: Value) -> ApiResult<Self> {
        let references = value.get("references").is_some();
        serde_json::from_value(value).map_err(|e| {
            if references {
                reference_validation(e.to_string())
            } else {
                ApiError::validation_failed(e.to_string())
            }
        })
    }

    pub fn image_ids(&self) -> Vec<Uuid> {
        self.references.as_ref().map_or_else(
            || self.image_ids.clone().unwrap_or_default(),
            |refs| refs.iter().map(|reference| reference.image_id).collect(),
        )
    }

    pub fn validate(&self) -> ApiResult<()> {
        if self.price < 0 {
            return Err(ApiError::validation_failed("price must not be negative"));
        }
        if self.cost_price.is_some_and(|cost| cost < 0) {
            return Err(ApiError::validation_failed(
                "cost_price must not be negative",
            ));
        }
        if let Some(name) = &self.name {
            check_len(name, NAME_MAX, "name")?;
        }
        if let Some(base) = &self.base_unit {
            check_len(base, UNIT_MAX, "base_unit")?;
        }
        if let Some(barcode) = &self.barcode {
            check_len(barcode, BARCODE_MAX, "barcode")?;
        }
        match (&self.image_ids, &self.references) {
            (Some(ids), None) => {
                let mut seen = std::collections::HashSet::new();
                if ids.is_empty()
                    || ids.len() > MAX_LEGACY_IMAGE_IDS
                    || !ids.iter().all(|id| seen.insert(*id))
                {
                    return Err(ApiError::validation_failed(
                        "expected 1 to 5 distinct image ids",
                    ));
                }
            }
            (None, Some(refs)) => {
                if refs.len() > MAX_IMAGES {
                    return Err(ApiError::conflict(
                        "image_limit",
                        "product supports at most 8 images",
                    ));
                }
                if refs.len() < MIN_REFERENCES {
                    return Err(reference_validation("expected at least 3 references"));
                }
                let mut seen = std::collections::HashSet::new();
                for reference in refs {
                    if !seen.insert(reference.image_id) {
                        return Err(reference_validation("expected distinct image ids"));
                    }
                    validate_bbox(&reference.bbox)?;
                }
            }
            _ => {
                return Err(reference_validation(
                    "provide exactly one of references or image_ids",
                ));
            }
        }
        for unit in self.units.iter().flatten() {
            unit.validate()?;
        }
        Ok(())
    }
}

/// Merge-patch body: absent fields stay unchanged, JSON `null` clears optional values.
#[derive(Debug, Clone, Deserialize)]
pub struct ProductPatch {
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub name: Option<Option<String>>,
    pub price: Option<i64>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub cost_price: Option<Option<i64>>,
    pub base_unit: Option<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub barcode: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub category_id: Option<Option<Uuid>>,
    pub units: Option<Vec<ProductUnitInput>>,
    pub archived: Option<bool>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub low_stock_threshold: Option<Option<i32>>,
}

pub fn validate_patch(patch: &ProductPatch) -> ApiResult<()> {
    if patch
        .low_stock_threshold
        .flatten()
        .is_some_and(|n| !(0..=100000).contains(&n))
    {
        return Err(ApiError::validation_failed("invalid low stock threshold"));
    }
    if patch.price.is_some_and(|price| price < 0) {
        return Err(ApiError::validation_failed("price must not be negative"));
    }
    if patch
        .cost_price
        .is_some_and(|cost| cost.is_some_and(|v| v < 0))
    {
        return Err(ApiError::validation_failed(
            "cost_price must not be negative",
        ));
    }
    if let Some(Some(name)) = &patch.name {
        check_len(name, NAME_MAX, "name")?;
    }
    if let Some(base) = &patch.base_unit {
        check_len(base, UNIT_MAX, "base_unit")?;
    }
    if let Some(Some(barcode)) = &patch.barcode {
        check_len(barcode, BARCODE_MAX, "barcode")?;
    }
    for unit in patch.units.iter().flatten() {
        unit.validate()?;
    }
    Ok(())
}

#[derive(Debug, Clone, sqlx::FromRow, PartialEq)]
pub struct ProductRow {
    pub id: Uuid,
    pub name: Option<String>,
    pub price: i64,
    pub cost_price: Option<i64>,
    pub base_unit: String,
    pub barcode: Option<String>,
    pub category_id: Option<Uuid>,
    pub archived: bool,
    pub stock_quantity: Option<i32>,
    pub low_stock_threshold: Option<i32>,
    pub store_stock_threshold: i32,
    pub version: i64,
    pub created_by: Uuid,
    pub updated_at: DateTime<Utc>,
    pub index_status: String,
}

#[derive(Debug, Clone, sqlx::FromRow, PartialEq)]
pub struct UnitRow {
    pub id: Uuid,
    pub name: String,
    pub quantity_in_base: i32,
    pub price: i64,
    pub barcode: Option<String>,
}

/// Aggregate with units and images (object_key is internal, stripped in responses).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProductListRow {
    #[sqlx(flatten)]
    pub product: ProductRow,
    pub units: Value,
    pub images: Value,
}

pub const PRODUCT_FIELDS: &str = "p.id, p.name, p.price, p.cost_price, p.base_unit, p.barcode, \
     p.category_id, p.archived, p.version, p.created_by, p.updated_at, p.stock_quantity, p.low_stock_threshold, (SELECT low_stock_threshold FROM stores WHERE id=p.store_id) AS store_stock_threshold, p.index_status";

pub const UNITS_JSON: &str = "COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', \
     u.name, 'quantity_in_base', u.quantity_in_base, 'price', u.price, 'barcode', u.barcode) \
     ORDER BY u.id) FROM product_units u WHERE u.product_id = p.id), '[]'::jsonb) AS units";

pub const IMAGES_JSON: &str = "COALESCE((SELECT jsonb_agg(jsonb_build_object('image_id', \
     pi.image_id, 'position', pi.position, 'object_key', im.object_key, \
     'cutout_image_id', pi.cutout_image_id, 'bbox', pi.bbox) ORDER BY pi.position, \
     pi.image_id) FROM product_images pi JOIN images im ON im.id = pi.image_id WHERE \
     pi.product_id = p.id), '[]'::jsonb) AS images";

pub const PRODUCT_AGG_SELECT: &str = concat!(
    "SELECT ",
    "p.id, p.name, p.price, p.cost_price, p.base_unit, p.barcode, p.category_id, p.archived, ",
    "p.version, p.created_by, p.updated_at, p.stock_quantity, p.low_stock_threshold, (SELECT low_stock_threshold FROM stores WHERE id=p.store_id) AS store_stock_threshold, p.index_status, ",
    "COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'quantity_in_base', ",
    "u.quantity_in_base, 'price', u.price, 'barcode', u.barcode) ORDER BY u.id) ",
    "FROM product_units u WHERE u.product_id = p.id), '[]'::jsonb) AS units, ",
    "COALESCE((SELECT jsonb_agg(jsonb_build_object('image_id', pi.image_id, 'position', ",
    "pi.position, 'object_key', im.object_key, 'cutout_image_id', pi.cutout_image_id, ",
    "'bbox', pi.bbox) ORDER BY pi.position, pi.image_id) ",
    "FROM product_images pi JOIN images im ON im.id = pi.image_id WHERE pi.product_id = p.id), ",
    "'[]'::jsonb) AS images ",
    "FROM products p WHERE p.id = $1 AND p.store_id = $2"
);

pub const PRODUCT_SELECT_LOCK: &str = concat!(
    "SELECT p.id, p.name, p.price, p.cost_price, p.base_unit, p.barcode, p.category_id, ",
    "p.archived, p.version, p.created_by, p.updated_at, p.stock_quantity, p.low_stock_threshold, (SELECT low_stock_threshold FROM stores WHERE id=p.store_id) AS store_stock_threshold, p.index_status FROM products p WHERE p.id = $1 AND ",
    "p.store_id = $2 FOR UPDATE"
);

#[derive(Debug, Clone, PartialEq)]
pub enum UnitOp {
    Insert(ProductUnitInput),
    Update {
        unit: ProductUnitInput,
        price_changed: Option<(i64, i64)>,
    },
    Delete(Uuid),
}

#[derive(Debug, Default, PartialEq)]
pub struct PatchPlan {
    pub name: Option<Option<String>>,
    pub base_unit: Option<String>,
    pub barcode: Option<Option<String>>,
    pub category_id: Option<Option<Uuid>>,
    pub archived: Option<bool>,
    pub low_stock_threshold: Option<Option<i32>>,
    pub price: Option<(i64, i64)>,
    pub cost_price: Option<(Option<i64>, i64)>,
    /// Previous cost when the patch clears it; the history row keeps it.
    pub cost_clear: Option<i64>,
    pub unit_ops: Vec<UnitOp>,
}

impl PatchPlan {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

fn unit_same(existing: &UnitRow, unit: &ProductUnitInput) -> bool {
    existing.id == unit.id
        && existing.name == unit.name
        && existing.quantity_in_base == unit.quantity_in_base
        && existing.price == unit.price
        && existing.barcode == unit.barcode
}

/// Diff the patch against current values; pure logic, covered by tests below.
pub fn plan_patch(
    current: &ProductRow,
    existing_units: &[UnitRow],
    patch: ProductPatch,
) -> ApiResult<PatchPlan> {
    let mut plan = PatchPlan::default();
    if let Some(threshold) = patch.low_stock_threshold
        && threshold != current.low_stock_threshold
    {
        plan.low_stock_threshold = Some(threshold);
    }
    if let Some(price) = patch.price
        && price != current.price
    {
        plan.price = Some((current.price, price));
    }
    if let Some(cost) = patch.cost_price
        && cost != current.cost_price
    {
        match (cost, current.cost_price) {
            (Some(new), old) => plan.cost_price = Some((old, new)),
            (None, Some(old)) => plan.cost_clear = Some(old),
            (None, None) => {}
        }
    }
    if let Some(archived) = patch.archived
        && archived != current.archived
    {
        plan.archived = Some(archived);
    }
    if let Some(name) = &patch.name
        && *name != current.name
    {
        plan.name = patch.name.clone();
    }
    if let Some(base_unit) = &patch.base_unit
        && *base_unit != current.base_unit
    {
        plan.base_unit = patch.base_unit.clone();
    }
    if let Some(barcode) = &patch.barcode
        && *barcode != current.barcode
    {
        plan.barcode = patch.barcode.clone();
    }
    if let Some(category_id) = &patch.category_id
        && *category_id != current.category_id
    {
        plan.category_id = patch.category_id;
    }
    if let Some(replacement) = &patch.units {
        for unit in replacement {
            match existing_units.iter().find(|e| e.id == unit.id) {
                Some(existing) if unit_same(existing, unit) => {}
                Some(existing) => {
                    let price_changed =
                        (existing.price != unit.price).then_some((existing.price, unit.price));
                    plan.unit_ops.push(UnitOp::Update {
                        unit: unit.clone(),
                        price_changed,
                    });
                }
                None => plan.unit_ops.push(UnitOp::Insert(unit.clone())),
            }
        }
        for existing in existing_units {
            if !replacement.iter().any(|u| u.id == existing.id) {
                plan.unit_ops.push(UnitOp::Delete(existing.id));
            }
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create(price: i64, images: usize) -> CreateProductRequest {
        CreateProductRequest {
            id: Uuid::now_v7(),
            price,
            image_ids: Some(vec![Uuid::now_v7(); images]),
            references: None,
            name: None,
            base_unit: None,
            cost_price: None,
            barcode: None,
            category_id: None,
            units: None,
            from_manual_line_id: None,
            force_new: false,
        }
    }

    #[test]
    fn create_validation_rejects_price_images_and_units() {
        assert!(create(-1, 1).validate().is_err());
        assert!(create(1, 0).validate().is_err());
        assert!(create(1, 6).validate().is_err());
        let mut request = create(1, 1);
        request.units = Some(vec![ProductUnitInput {
            id: Uuid::now_v7(),
            name: "lốc".into(),
            quantity_in_base: 1,
            price: 100,
            barcode: None,
        }]);
        assert!(request.validate().is_err());
        let mut request = create(1, 1);
        request.name = Some("x".repeat(121));
        assert!(request.validate().is_err());
        assert!(create(1, 1).validate().is_ok());
    }

    #[test]
    fn patch_validation_and_reals() {
        let patch = |value: Value| -> ProductPatch { serde_json::from_value(value).unwrap() };
        assert!(patch(json!({})).archived.is_none());
        let cleared: ProductPatch = patch(json!({"name": null}));
        assert_eq!(cleared.name, Some(None));
        let bad = patch(json!({"price": -5}));
        assert!(validate_patch(&bad).is_err());
        let long_name = patch(json!({"name": "x".repeat(121)}));
        assert!(validate_patch(&long_name).is_err());
        let small_unit = patch(
            json!({"units": [{"id": Uuid::now_v7(), "name": "lốc", "quantity_in_base": 1, "price": 5}]}),
        );
        assert!(validate_patch(&small_unit).is_err());
    }

    fn row(price: i64, cost: Option<i64>) -> ProductRow {
        ProductRow {
            id: Uuid::now_v7(),
            name: Some("Coca".into()),
            price,
            cost_price: cost,
            base_unit: "chai".into(),
            barcode: None,
            category_id: None,
            archived: false,
            stock_quantity: None,
            low_stock_threshold: None,
            store_stock_threshold: 5,
            version: 1,
            created_by: Uuid::now_v7(),
            updated_at: Utc::now(),
            index_status: "ready".into(),
        }
    }

    #[test]
    fn patch_plan_diffs_only_real_changes() {
        let current = row(9000, Some(7000));
        let patch: ProductPatch =
            serde_json::from_value(json!({"price": 9000, "cost_price": 7000})).unwrap();
        assert!(plan_patch(&current, &[], patch).unwrap().is_empty());
        let patch: ProductPatch = serde_json::from_value(
            json!({"price": 10000, "cost_price": 7500, "name": "Coca 330ml", "archived": true}),
        )
        .unwrap();
        let plan = plan_patch(&current, &[], patch).unwrap();
        assert_eq!(plan.price, Some((9000, 10000)));
        assert_eq!(plan.cost_price, Some((Some(7000), 7500)));
        assert_eq!(plan.name, Some(Some("Coca 330ml".into())));
        assert_eq!(plan.archived, Some(true));
    }

    #[test]
    fn patch_plan_diffs_unit_replacement() {
        let current = row(9000, None);
        let old_id = Uuid::now_v7();
        let other_id = Uuid::now_v7();
        let gone_id = Uuid::now_v7();
        let existing = vec![
            UnitRow {
                id: old_id,
                name: "thùng".into(),
                quantity_in_base: 24,
                price: 230000,
                barcode: None,
            },
            UnitRow {
                id: gone_id,
                name: "lốc cũ".into(),
                quantity_in_base: 6,
                price: 50000,
                barcode: None,
            },
        ];
        let patch: ProductPatch = serde_json::from_value(json!({"units": [
            {"id": old_id, "name": "thùng", "quantity_in_base": 24, "price": 220000},
            {"id": other_id, "name": "lốc", "quantity_in_base": 6, "price": 60000}
        ]}))
        .unwrap();
        let plan = plan_patch(&current, &existing, patch).unwrap();
        assert_eq!(plan.unit_ops.len(), 3);
        assert!(plan.unit_ops.contains(&UnitOp::Update {
            unit: ProductUnitInput {
                id: old_id,
                name: "thùng".into(),
                quantity_in_base: 24,
                price: 220000,
                barcode: None
            },
            price_changed: Some((230000, 220000)),
        }));
        assert!(plan.unit_ops.contains(&UnitOp::Insert(ProductUnitInput {
            id: other_id,
            name: "lốc".into(),
            quantity_in_base: 6,
            price: 60000,
            barcode: None
        })));
        assert!(plan.unit_ops.contains(&UnitOp::Delete(gone_id)));
    }
}
