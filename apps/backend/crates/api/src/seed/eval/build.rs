//! Pure generation of the eval dataset. No clock, no entropy, no database: every random choice
//! comes from a [`Prng`] keyed by a fixed string, and iteration is over vectors or `BTreeMap`s.
use super::catalog::*;
use super::model::*;
use super::{ledger, sales, supply};
use crate::seed::Prng;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) const SEED: &str = "taphoa-mini/eval-store/seed-v1";

// ---- ids ----------------------------------------------------------------------------------
// Own UUID namespace (v1 fixtures use the 0x7a906e00 prefix), a table number in bits 40-47 and
// a per-table counter below. Nothing depends on a clock, entropy, insertion order or a sequence.
const NAMESPACE: u128 = 0xe7a1_0e7a_0000_4000_8000_0000_0000_0000;
pub(super) const T_STORE: u16 = 0;
pub(super) const T_MEMBER: u16 = 1;
pub(super) const T_INVITE: u16 = 3;
pub(super) const T_CATEGORY: u16 = 4;
pub(super) const T_PRODUCT: u16 = 5;
pub(super) const T_UNIT: u16 = 6;
pub(super) const T_EMBEDDING: u16 = 7;
pub(super) const T_PRICE_HISTORY: u16 = 8;
pub(super) const T_IMAGE: u16 = 10;
pub(super) const T_SALE: u16 = 20;
pub(super) const T_SALE_LINE: u16 = 21;
pub(super) const T_SCAN: u16 = 22;
pub(super) const T_DETECTION: u16 = 23;
pub(super) const T_EXPENSE: u16 = 24;
pub(super) const T_PURCHASE_LINE: u16 = 25;
pub(super) const T_ALERT: u16 = 26;
pub(super) const T_MOVEMENT: u16 = 30;
pub(super) const T_RECEIPT: u16 = 31;
pub(super) const T_RECEIPT_LINE: u16 = 32;

pub(super) fn id(table: u16, n: u64) -> Uuid {
    Uuid::from_u128(NAMESPACE | (u128::from(table) << 40) | u128::from(n))
}

// ---- time ---------------------------------------------------------------------------------

pub(super) fn ymd(d: Ymd) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.0, d.1, d.2).expect("fixture date")
}

pub(super) fn local(date: NaiveDate, hour: u32, minute: u32, second: u32) -> DateTime<Utc> {
    Ho_Chi_Minh
        .from_local_datetime(
            &date
                .and_hms_opt(hour, minute, second)
                .expect("fixture time"),
        )
        .single()
        .expect("Vietnam has no daylight saving time")
        .with_timezone(&Utc)
}

pub(super) fn at(when: (Ymd, (u32, u32))) -> DateTime<Utc> {
    local(ymd(when.0), (when.1).0, (when.1).1, 0)
}

pub(super) fn round50(v: i64) -> i64 {
    ((v + 25) / 50) * 50
}

pub(super) fn dotted(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

// ---- products at run time -----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Role {
    Normal,
    /// Stock, no sale since a date 35+ days before the pinned date.
    Dead,
    Never,
    /// Last sale 17-23 days before the pinned date.
    Slow,
    Seasonal,
}

pub(super) struct UnitInfo {
    pub id: Uuid,
    pub name: &'static str,
    pub qib: i32,
    pub price: i64,
}

pub(super) struct Prod {
    pub id: Uuid,
    pub spec: &'static Spec,
    pub role: Role,
    pub tracked: bool,
    /// Effective-from instant and retail price.
    pub prices: Vec<(DateTime<Utc>, i64)>,
    /// Effective-from date and cost per base unit.
    pub costs: Vec<(NaiveDate, i64)>,
    /// (supplier index, cost factor in per mille); the first is the primary supplier.
    pub suppliers: Vec<(usize, i64)>,
    pub units: Vec<UnitInfo>,
    /// Random sales stop after this date.
    pub last_active: Option<NaiveDate>,
    /// Random sales stop from this instant.
    pub frozen_from: Option<DateTime<Utc>>,
    pub refs: usize,
}

impl Prod {
    pub fn price_at(&self, when: DateTime<Utc>) -> i64 {
        self.prices
            .iter()
            .rev()
            .find(|(from, _)| *from <= when)
            .map_or(self.prices[0].1, |(_, p)| *p)
    }

    pub fn cost_on(&self, date: NaiveDate) -> i64 {
        self.costs
            .iter()
            .rev()
            .find(|(from, _)| *from <= date)
            .map_or(self.costs[0].1, |(_, c)| *c)
    }

    pub fn threshold(&self) -> i32 {
        match self.spec.stock {
            Stock::Th(t) => t,
            _ => STORE_LOW_STOCK_THRESHOLD,
        }
    }
}

pub(super) struct Ctx {
    pub prods: Vec<Prod>,
    pub by_name: BTreeMap<&'static str, usize>,
    pub members: [Uuid; 3],
    pub first: NaiveDate,
    pub today: NaiveDate,
    pub now: DateTime<Utc>,
    pub created: DateTime<Utc>,
    pub total_weight: u64,
}

impl Ctx {
    pub fn p(&self, name: &str) -> usize {
        *self
            .by_name
            .get(name)
            .unwrap_or_else(|| panic!("fixture product missing: {name}"))
    }

    pub fn member(&self, name: &str) -> usize {
        MEMBERS
            .iter()
            .position(|m| m.name == name)
            .unwrap_or_else(|| panic!("fixture member missing: {name}"))
    }

    fn new() -> Self {
        let first = ymd(FIRST_DAY);
        let today = ymd(TODAY);
        let created = local(ymd(CREATED), 9, 0, 0);
        let mut by_name = BTreeMap::new();
        let mut prods = Vec::with_capacity(SPECS.len());
        let mut unit_counter = 0u64;
        for (i, spec) in SPECS.iter().enumerate() {
            assert!(
                by_name.insert(spec.name, i).is_none(),
                "duplicate product {}",
                spec.name
            );
            let mut last_active = None;
            let role = if let Some((_, d)) = DEAD_STOCK.iter().find(|(n, _)| *n == spec.name) {
                last_active = Some(ymd(*d));
                Role::Dead
            } else if NEVER_SOLD.contains(&spec.name) {
                Role::Never
            } else if let Some((_, d)) = SLOW_MOVERS.iter().find(|(n, _)| *n == spec.name) {
                last_active = Some(ymd(*d));
                Role::Slow
            } else if SEASONAL.contains(&spec.name) {
                Role::Seasonal
            } else {
                Role::Normal
            };
            let tracked = spec.stock != Stock::No;
            let frozen_from = NEGATIVE_STOCK
                .iter()
                .any(|(n, ..)| *n == spec.name)
                .then(|| local(ymd(NEGATIVE_STOCK_COUNT_AT.0), 18, 0, 0));
            // Retail price timeline: the old price of the first change, then each change at 08:30.
            let changes: Vec<_> = PRICE_CHANGES.iter().filter(|c| c.0 == spec.name).collect();
            let mut prices = vec![(created, changes.first().map_or(spec.price, |c| c.2))];
            for c in &changes {
                prices.push((local(ymd(c.1), 8, 30, 0), c.3));
            }
            // Cost timeline: explicit changes, or a small drift that never makes a margin thin.
            let mut costs = vec![(ymd(CREATED), spec.cost)];
            if let Some((_, list)) = COST_CHANGES.iter().find(|(n, _)| *n == spec.name) {
                costs.extend(list.iter().map(|(d, c)| (ymd(*d), *c)));
            } else if tracked && role == Role::Normal {
                let mut rng = Prng::new(&format!("{SEED}/drift/{}", spec.name));
                if rng.next() % 100 < 45 {
                    let when = ymd((2026, 9, 1)) + Duration::days((rng.next() % 40) as i64);
                    let pct = 3 + (rng.next() % 6) as i64;
                    let cost = round50(spec.cost * (100 + pct) / 100);
                    let lowest = prices.iter().map(|p| p.1).min().unwrap_or(spec.price);
                    if (lowest - cost) * 100 >= lowest * 13 {
                        costs.push((when, cost));
                    }
                }
            }
            let suppliers = match MULTI_SUPPLIER.iter().find(|(n, _)| *n == spec.name) {
                Some((_, list)) => list.to_vec(),
                None => vec![(spec.cat.map_or(0, |c| CATEGORY_SUPPLIER[c]), 1000)],
            };
            let mut units = Vec::new();
            if let Some((_, list)) = UNITS.iter().find(|(n, _)| *n == spec.name) {
                for (name, qib) in *list {
                    let price = ((i64::from(*qib) * spec.price * 97 / 100 + 250) / 500) * 500;
                    units.push(UnitInfo {
                        id: id(T_UNIT, unit_counter),
                        name,
                        qib: *qib,
                        price,
                    });
                    unit_counter += 1;
                }
            }
            let refs = if NO_PHOTOS.contains(&spec.name) {
                0
            } else if let Some((_, n)) = FEW_REFERENCES.iter().find(|(name, _)| *name == spec.name)
            {
                *n
            } else if spec.weight >= 8 {
                TOP_SELLER_REFERENCES
            } else {
                STANDARD_REFERENCES
            };
            prods.push(Prod {
                id: id(T_PRODUCT, i as u64),
                spec,
                role,
                tracked,
                prices,
                costs,
                suppliers,
                units,
                last_active,
                frozen_from,
                refs,
            });
        }
        let total_weight = SPECS.iter().map(|s| u64::from(s.weight)).sum();
        Ctx {
            prods,
            by_name,
            members: [id(T_MEMBER, 0), id(T_MEMBER, 1), id(T_MEMBER, 2)],
            first,
            today,
            now: local(today, NOW_LOCAL.0, NOW_LOCAL.1, 0),
            created,
            total_weight,
        }
    }
}

/// Allocates image rows (no object is ever written to storage).
#[derive(Default)]
pub(super) struct Images {
    pub rows: Vec<ImageRow>,
}

impl Images {
    pub fn alloc(&mut self, purpose: &'static str, by: Uuid, when: DateTime<Utc>) -> Uuid {
        let image = id(T_IMAGE, self.rows.len() as u64);
        let day = when.with_timezone(&Ho_Chi_Minh);
        self.rows.push(ImageRow {
            id: image,
            object_key: format!("images/{}/{:02}/{image}.jpg", day.year(), day.month()),
            purpose,
            uploaded_by: by,
            created_at: when,
        });
        image
    }
}

fn identity(ctx: &Ctx) -> Identity {
    let created = ctx.created;
    let members = MEMBERS
        .iter()
        .enumerate()
        .map(|(i, m)| MemberRow {
            id: ctx.members[i],
            key: m.key,
            name: m.name,
            role: m.role,
            can_enroll: m.can_enroll,
            pin: m.pin,
            login: m.login,
            created_at: created + Duration::minutes(5 + i as i64),
        })
        .collect();
    let lead = ctx.members[0];
    let used = |n: u64, who: usize, token: &str| InviteRow {
        id: id(T_INVITE, n),
        token: token.into(),
        role: "seller",
        can_enroll: MEMBERS[who].can_enroll,
        created_by: lead,
        used_by: Some(ctx.members[who]),
        created_at: created + Duration::minutes(2),
        used_at: Some(created + Duration::minutes(5 + who as i64)),
    };
    Identity {
        members,
        invites: vec![
            used(0, 1, "eval-invite-used-be-na"),
            used(1, 2, "eval-invite-used-anh-tu"),
            InviteRow {
                id: id(T_INVITE, 2),
                token: PENDING_INVITE_TOKEN.into(),
                role: "seller",
                can_enroll: false,
                created_by: lead,
                used_by: None,
                created_at: local(ymd((2026, 10, 18)), 10, 0, 0),
                used_at: None,
            },
        ],
    }
}

pub(super) fn build() -> Dataset {
    let ctx = Ctx::new();
    let lead = ctx.members[0];
    let mut images = Images::default();

    // Reference photos: one image row each, created with the product.
    let mut product_images = Vec::new();
    for (i, p) in ctx.prods.iter().enumerate() {
        let created = ctx.created + Duration::minutes(i as i64);
        for position in 0..p.refs {
            let image = images.alloc(
                "enrollment",
                lead,
                created + Duration::seconds(position as i64),
            );
            product_images.push(ProductImageRow {
                product: p.id,
                image,
                position: position as i16,
                created_at: created + Duration::seconds(position as i64),
            });
        }
    }

    let sale_data = sales::generate(&ctx, &mut images);
    let supply_data = supply::generate(&ctx, &mut images);
    let ledger_data = ledger::build(&ctx, &sale_data, &supply_data);

    let mut expenses = supply_data.expenses.clone();
    expenses.extend(supply::fixed_expenses(&ctx));
    expenses.sort_by_key(|e| (e.spent_at, e.id));

    let day_closes = day_closes(&ctx, &sale_data.sales, &expenses);

    // Price history: creation rows, retail price changes, then purchase cost changes.
    let mut price_history = Vec::new();
    for (i, p) in ctx.prods.iter().enumerate() {
        let created = ctx.created + Duration::minutes(i as i64);
        let row = |unit: Option<Uuid>,
                   field: &'static str,
                   old: Option<i64>,
                   new: i64,
                   source: &'static str,
                   at: DateTime<Utc>| PriceHistoryRow {
            id: Uuid::nil(),
            product: p.id,
            unit,
            field,
            old,
            new,
            source,
            changed_by: lead,
            changed_at: at,
        };
        price_history.push(row(None, "price", None, p.prices[0].1, "manual", created));
        price_history.push(row(
            None,
            "cost_price",
            None,
            p.costs[0].1,
            "manual",
            created,
        ));
        for u in &p.units {
            price_history.push(row(
                Some(u.id),
                "unit_price",
                None,
                u.price,
                "manual",
                created,
            ));
        }
        for w in p.prices.windows(2) {
            price_history.push(row(None, "price", Some(w[0].1), w[1].1, "manual", w[1].0));
        }
    }
    price_history.extend(supply_data.cost_history.iter().cloned());
    price_history.sort_by_key(|h| (h.changed_at, h.product, h.field, h.unit));
    for (n, h) in price_history.iter_mut().enumerate() {
        h.id = id(T_PRICE_HISTORY, n as u64);
    }

    let final_cost: BTreeMap<Uuid, i64> = supply_data.final_cost.clone();
    let mut touched: BTreeMap<Uuid, DateTime<Utc>> = BTreeMap::new();
    for h in &price_history {
        let e = touched.entry(h.product).or_insert(h.changed_at);
        *e = (*e).max(h.changed_at);
    }
    for m in &ledger_data.movements {
        let e = touched.entry(m.product).or_insert(m.at);
        *e = (*e).max(m.at);
    }
    let products = ctx
        .prods
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let created = ctx.created + Duration::minutes(i as i64);
            ProductRow {
                id: p.id,
                name: p.spec.name,
                category: p.spec.cat.map(|c| id(T_CATEGORY, c as u64)),
                base_unit: p.spec.unit,
                price: p.prices.last().expect("price").1,
                cost: final_cost.get(&p.id).copied().unwrap_or(p.costs[0].1),
                barcode: p.spec.barcode.then(|| format!("8930{:09}", i * 7 + 1000)),
                stock: ledger_data.stock.get(&p.id).copied(),
                threshold: match p.spec.stock {
                    Stock::Th(t) => Some(t),
                    _ => None,
                },
                created_by: lead,
                created_at: created,
                updated_at: touched.get(&p.id).copied().unwrap_or(created).max(created),
            }
        })
        .collect();
    let units = ctx
        .prods
        .iter()
        .flat_map(|p| {
            p.units.iter().map(|u| UnitRow {
                id: u.id,
                product: p.id,
                name: u.name,
                quantity_in_base: u.qib,
                price: u.price,
            })
        })
        .collect();

    Dataset {
        today: ctx.today,
        first_day: ctx.first,
        now: ctx.now,
        store: StoreRow {
            id: id(T_STORE, 0),
            name: STORE_NAME,
            bank_bin: BANK.0,
            bank_short_name: BANK.1,
            bank_account_number: BANK.2,
            bank_account_name: BANK.3,
            margin_threshold_pct: MARGIN_THRESHOLD_PCT,
            low_stock_threshold: STORE_LOW_STOCK_THRESHOLD,
            created_at: ctx.created,
        },
        identity: identity(&ctx),
        categories: CATEGORIES
            .iter()
            .enumerate()
            .map(|(i, name)| CategoryRow {
                id: id(T_CATEGORY, i as u64),
                name,
                created_at: ctx.created,
            })
            .collect(),
        products,
        units,
        images: images.rows,
        product_images,
        price_history,
        scans: sale_data.scans,
        detections: sale_data.detections,
        sales: sale_data.sales,
        sale_lines: sale_data.lines,
        expenses,
        purchase_lines: supply_data.purchase_lines,
        receipts: supply_data.receipts,
        receipt_lines: supply_data.receipt_lines,
        movements: ledger_data.movements,
        day_closes,
        alerts: supply_data.alerts,
    }
}

/// Closes every business date but today and the documented unclosed days, from the sales and
/// cash expenses of the date (the same sums the day-close endpoint computes).
fn day_closes(ctx: &Ctx, sales: &[SaleRow], expenses: &[ExpenseRow]) -> Vec<DayCloseRow> {
    let lead = ctx.members[0];
    let unclosed: Vec<NaiveDate> = UNCLOSED_DAYS.iter().map(|d| ymd(*d)).collect();
    let (diff_day, diff) = (ymd(CASH_DIFFERENCE.0), CASH_DIFFERENCE.1);
    let mut out = Vec::new();
    let mut date = ctx.first;
    while date < ctx.today {
        if !unclosed.contains(&date) {
            let cash_sales: i64 = sales
                .iter()
                .filter(|s| s.date == date && s.cash)
                .map(|s| s.total)
                .sum();
            let cash_refunds: i64 = sales
                .iter()
                .filter(|s| s.date == date && s.cash && s.void.is_some())
                .map(|s| s.total)
                .sum();
            let transfer_revenue: i64 = sales
                .iter()
                .filter(|s| s.date == date && !s.cash && s.void.is_none())
                .map(|s| s.total)
                .sum();
            let cash_expenses: i64 = expenses
                .iter()
                .filter(|e| e.date == date && e.paid_with == "cash_box")
                .map(|e| e.amount)
                .sum();
            let expected = OPENING_FLOAT + cash_sales - cash_refunds - cash_expenses;
            let short = date == diff_day;
            out.push(DayCloseRow {
                date,
                opening_float: OPENING_FLOAT,
                cash_sales,
                cash_refunds,
                cash_expenses,
                expected_cash: expected,
                counted_cash: if short { expected + diff } else { expected },
                transfer_revenue,
                note: Some(if short {
                    "Thiếu tiền quỹ, chưa rõ nguyên nhân, sẽ đếm lại"
                } else {
                    "Đã kiểm quỹ"
                }),
                closed_by: lead,
                closed_at: local(date, 21, 45, 0),
            });
        }
        date += Duration::days(1);
    }
    out
}
