//! Database-free checks of the generated eval dataset and of the fixtures documented in
//! `packages/eval/STORE.md`.
use super::catalog::*;
use super::model::*;
use super::{
    build::{build, dotted},
    ensure_not_production,
};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use uuid::Uuid;

static DS: LazyLock<Dataset> = LazyLock::new(build);

fn ymd(d: Ymd) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.0, d.1, d.2).unwrap()
}
fn local(at: DateTime<Utc>) -> chrono::DateTime<chrono_tz::Tz> {
    at.with_timezone(&Ho_Chi_Minh)
}
fn at(d: Ymd, hm: (u32, u32)) -> DateTime<Utc> {
    Ho_Chi_Minh
        .from_local_datetime(&ymd(d).and_hms_opt(hm.0, hm.1, 0).unwrap())
        .unwrap()
        .with_timezone(&Utc)
}
fn product(name: &str) -> &'static ProductRow {
    DS.products
        .iter()
        .find(|p| p.name == name)
        .unwrap_or_else(|| panic!("fixture product missing: {name}"))
}
fn threshold(p: &ProductRow) -> i32 {
    p.threshold.unwrap_or(STORE_LOW_STOCK_THRESHOLD)
}
fn member(name: &str) -> &'static MemberRow {
    DS.identity
        .members
        .iter()
        .find(|m| m.name == name)
        .unwrap_or_else(|| panic!("fixture member missing: {name}"))
}
fn names(set: &BTreeSet<&'static str>) -> Vec<&'static str> {
    set.iter().copied().collect()
}
fn sorted<'a>(items: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut v: Vec<_> = items.into_iter().collect();
    v.sort_unstable();
    v
}
fn name_of(id: Uuid) -> &'static str {
    DS.products.iter().find(|p| p.id == id).unwrap().name
}
fn margin_pct(p: &ProductRow) -> f64 {
    (p.price - p.cost) as f64 * 100.0 / p.price as f64
}
fn completed_sales() -> impl Iterator<Item = &'static SaleRow> {
    DS.sales.iter().filter(|s| s.void.is_none())
}
/// Names of products with at least one line in a completed sale on a date in `range`.
fn sold_between(from: NaiveDate, to: NaiveDate) -> BTreeSet<Uuid> {
    let in_range: BTreeSet<Uuid> = completed_sales()
        .filter(|s| s.date >= from && s.date <= to)
        .map(|s| s.id)
        .collect();
    DS.sale_lines
        .iter()
        .filter(|l| in_range.contains(&l.sale))
        .filter_map(|l| l.product)
        .collect()
}

// ---- the exact table rows of STORE.md ------------------------------------------------------
// `print_rows` prints them; `store_md_documents_every_fixture` requires each one in the file.

/// The injection product's 100-character name would widen every table; its rows carry a label.
fn shown(name: &str) -> &str {
    if name == INJECTION_PRODUCT {
        "Bánh quy bơ Danisa 200g (tên chứa lệnh chèn, xem mục Canary)"
    } else {
        name
    }
}

fn catalog_row(s: &Spec) -> String {
    let p = product(s.name);
    let start = DS
        .price_history
        .iter()
        .filter(|h| h.product == p.id && h.field == "price" && h.unit.is_none())
        .min_by_key(|h| h.changed_at)
        .unwrap()
        .new;
    let stock = match s.stock {
        Stock::No => "không theo dõi".to_string(),
        Stock::Default => "mặc định (5)".to_string(),
        Stock::Th(t) => t.to_string(),
    };
    format!(
        "| {} | {} | {} | {} | {} | {} | {} | {} |",
        s.cat.map_or("(không có)", |c| CATEGORIES[c]),
        shown(s.name),
        s.unit,
        dotted(s.price),
        dotted(start),
        dotted(s.cost),
        stock,
        if s.barcode { "có" } else { "không" },
    )
}

fn stock_row(name: &str) -> String {
    let p = product(name);
    format!(
        "| {} | {} | {} |",
        shown(name),
        p.stock.unwrap(),
        threshold(p)
    )
}

fn margin_row(name: &str) -> String {
    let p = product(name);
    format!(
        "| {} | {} | {} | {:.1}% |",
        name,
        dotted(p.price),
        dotted(p.cost),
        margin_pct(p)
    )
}

const SUPPLIER_SHORT: [&str; 3] = ["HT", "MP", "BS"];

fn cost_row(name: &str) -> String {
    let p = product(name);
    let mut steps: Vec<(DateTime<Utc>, String)> = DS
        .purchase_lines
        .iter()
        .filter(|l| l.product == p.id)
        .map(|l| {
            let e = DS.expenses.iter().find(|e| e.id == l.expense).unwrap();
            let r = DS
                .receipts
                .iter()
                .find(|r| r.expense == Some(e.id))
                .unwrap();
            (
                e.spent_at,
                format!(
                    "{} {} {}",
                    e.date,
                    SUPPLIER_SHORT[r.supplier],
                    dotted(l.unit_cost)
                ),
            )
        })
        .collect();
    steps.sort();
    let joined: Vec<String> = steps.into_iter().map(|s| s.1).collect();
    format!("| {} | {} |", name, joined.join("; "))
}

fn draft_row(l: &ReceiptLineRow) -> String {
    format!(
        "| {} | {} | {} | {} | {} | {} |",
        l.position + 1,
        l.product_name,
        l.quantity,
        dotted(l.cost / i64::from(l.quantity)),
        l.product.map_or("(không khớp)", name_of),
        l.confidence.map_or("-".to_string(), |c| format!("{c:.2}")),
    )
}

fn draft_lines() -> Vec<&'static ReceiptLineRow> {
    let d = DS.receipts.iter().find(|r| r.status == "draft").unwrap();
    DS.receipt_lines
        .iter()
        .filter(|l| l.receipt == d.id)
        .collect()
}

fn cost_rows_of() -> Vec<&'static str> {
    let mut v: Vec<&str> = MULTI_SUPPLIER.iter().map(|x| x.0).collect();
    v.extend(COST_CHANGES.iter().map(|x| x.0));
    v.sort_unstable();
    v.dedup();
    v
}

#[test]
fn dataset_is_identical_across_two_generations() {
    assert!(build() == build(), "generation depends on clock or entropy");
    assert!(*DS == build());
}

#[test]
fn production_environment_is_refused() {
    assert!(ensure_not_production(Some("production")).is_err());
    assert!(ensure_not_production(Some("test")).is_ok());
    assert!(ensure_not_production(Some("")).is_ok());
    assert!(ensure_not_production(None).is_ok());
}

#[test]
fn date_range_and_cutoff() {
    assert_eq!(DS.today, ymd(TODAY));
    let dates: BTreeSet<NaiveDate> = DS.sales.iter().map(|s| s.date).collect();
    assert_eq!(dates.len(), 60);
    assert_eq!(*dates.first().unwrap(), ymd((2026, 8, 22)));
    assert_eq!(*dates.last().unwrap(), ymd((2026, 10, 20)));
    let cutoff = at(TODAY, NOW_LOCAL);
    assert_eq!(DS.now, cutoff);
    let mut stamps: Vec<(&str, DateTime<Utc>)> = Vec::new();
    stamps.extend(DS.sales.iter().map(|s| ("sale", s.sold_at)));
    stamps.extend(
        DS.sales
            .iter()
            .filter_map(|s| s.void.as_ref().map(|v| ("void", v.at))),
    );
    stamps.extend(DS.expenses.iter().map(|e| ("expense", e.spent_at)));
    stamps.extend(DS.movements.iter().map(|m| ("movement", m.at)));
    stamps.extend(DS.receipts.iter().map(|r| ("receipt", r.created_at)));
    stamps.extend(
        DS.receipts
            .iter()
            .filter_map(|r| r.confirmed_at.map(|t| ("confirm", t))),
    );
    stamps.extend(DS.images.iter().map(|i| ("image", i.created_at)));
    stamps.extend(DS.scans.iter().map(|s| ("scan", s.created_at)));
    stamps.extend(DS.price_history.iter().map(|p| ("price", p.changed_at)));
    stamps.extend(DS.day_closes.iter().map(|d| ("close", d.closed_at)));
    stamps.extend(DS.alerts.iter().map(|a| ("alert", a.created_at)));
    stamps.extend(
        DS.alerts
            .iter()
            .filter_map(|a| a.resolved_at.map(|t| ("alert", t))),
    );
    stamps.extend(
        DS.sale_lines
            .iter()
            .filter_map(|l| l.review.as_ref().and_then(|r| r.at).map(|t| ("review", t))),
    );
    for (what, t) in stamps {
        assert!(t <= cutoff, "{what} at {t} is after 17:00 on 2026-10-20");
    }
    let last_day: Vec<_> = DS.sales.iter().filter(|s| s.date == ymd(TODAY)).collect();
    assert!(
        last_day.len() >= 20,
        "today has too few sales: {}",
        last_day.len()
    );
    assert!(DS.day_closes.iter().all(|d| d.date < ymd(TODAY)));
}

#[test]
fn catalog_has_ten_categories_and_about_120_products() {
    assert_eq!(DS.categories.len(), 10);
    assert!(
        (110..=130).contains(&DS.products.len()),
        "{}",
        DS.products.len()
    );
    let mut per_category: BTreeMap<Uuid, usize> = BTreeMap::new();
    for p in &DS.products {
        if let Some(c) = p.category {
            *per_category.entry(c).or_default() += 1;
        }
    }
    assert_eq!(per_category.len(), 10, "every category has products");
    assert!(per_category.values().all(|n| *n >= 10), "{per_category:?}");
    let unique: BTreeSet<_> = DS.products.iter().map(|p| p.name.to_lowercase()).collect();
    assert_eq!(unique.len(), DS.products.len(), "product names are unique");
    assert!(DS.products.iter().all(|p| p.name.chars().count() <= 120));
    let barcodes: Vec<_> = DS
        .products
        .iter()
        .filter_map(|p| p.barcode.as_ref())
        .collect();
    assert_eq!(
        barcodes.iter().collect::<BTreeSet<_>>().len(),
        barcodes.len()
    );
    assert!(
        barcodes.len() * 100 >= DS.products.len() * 70,
        "barcodes on most products"
    );
    let tracked: Vec<_> = DS.products.iter().filter(|p| p.stock.is_some()).collect();
    let untracked = DS.products.len() - tracked.len();
    assert!(
        (8..=25).contains(&untracked),
        "some products are untracked: {untracked}"
    );
    let with_threshold = tracked.iter().filter(|p| p.threshold.is_some()).count();
    assert!(
        with_threshold * 100 >= tracked.len() * 80,
        "thresholds on most tracked products"
    );
    assert!(
        tracked.len() - with_threshold >= 5,
        "thresholds are incomplete for the setup checklist"
    );
    assert!(DS.units.iter().all(|u| u.quantity_in_base >= 2));
    assert_eq!(
        DS.units.len(),
        UNITS.iter().map(|(_, u)| u.len()).sum::<usize>()
    );
}

#[test]
fn store_and_members() {
    assert_eq!(DS.store.name, "Tạp hóa Cô Ba");
    assert!(!DS.store.bank_bin.is_empty(), "bank account is set");
    assert_eq!(DS.identity.members.len(), 3);
    let ba = member(MEMBER_LEAD);
    assert_eq!((ba.role, ba.can_enroll), ("lead", true));
    assert!(ba.pin.is_some() && ba.login, "Cô Ba can log in");
    let na = member(MEMBER_SELLER);
    assert_eq!((na.role, na.can_enroll), ("seller", false));
    assert!(na.pin.is_some() && na.login, "Bé Na can log in");
    let tu = member(MEMBER_ENROLLER);
    assert_eq!((tu.role, tu.can_enroll), ("seller", true));
    assert!(tu.pin.is_none() && !tu.login, "Anh Tư cannot log in");
    let pending: Vec<_> = DS
        .identity
        .invites
        .iter()
        .filter(|i| i.used_at.is_none())
        .collect();
    assert_eq!(pending.len(), 1, "exactly one invite is pending");
    assert_eq!(DS.identity.invites.len() - pending.len(), 2);
    let keys: BTreeSet<_> = DS.identity.members.iter().map(|m| m.key).collect();
    assert_eq!(keys.len(), 3);
}

#[test]
fn ids_are_unique_and_disjoint_from_the_v1_fixtures() {
    let mut all: Vec<Uuid> = vec![DS.store.id];
    all.extend(DS.identity.members.iter().map(|m| m.id));
    all.extend(DS.identity.invites.iter().map(|i| i.id));
    all.extend(DS.categories.iter().map(|c| c.id));
    all.extend(DS.products.iter().map(|p| p.id));
    all.extend(DS.units.iter().map(|u| u.id));
    all.extend(DS.images.iter().map(|i| i.id));
    all.extend(DS.price_history.iter().map(|p| p.id));
    all.extend(DS.scans.iter().map(|s| s.id));
    all.extend(DS.detections.iter().map(|d| d.id));
    all.extend(DS.sales.iter().map(|s| s.id));
    all.extend(DS.sale_lines.iter().map(|l| l.id));
    all.extend(DS.expenses.iter().map(|e| e.id));
    all.extend(DS.purchase_lines.iter().map(|p| p.id));
    all.extend(DS.receipts.iter().map(|r| r.id));
    all.extend(DS.receipt_lines.iter().map(|l| l.id));
    all.extend(DS.movements.iter().map(|m| m.id));
    all.extend(DS.alerts.iter().map(|a| a.id));
    let unique: BTreeSet<_> = all.iter().collect();
    assert_eq!(unique.len(), all.len(), "duplicate ids");
    // v1 ids start with 0x7a906e00; the eval namespace must not share its first 32 bits.
    assert!(
        all.iter()
            .all(|id| (id.as_u128() >> 96) as u32 != 0x7a90_6e00)
    );
    assert!(
        all.iter().all(|id| id.get_version_num() == 4),
        "valid UUID version nibble"
    );
}

#[test]
fn weekday_pattern_and_the_three_spikes() {
    let mut count: BTreeMap<NaiveDate, usize> = BTreeMap::new();
    let mut revenue: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    for s in completed_sales() {
        *count.entry(s.date).or_default() += 1;
        *revenue.entry(s.date).or_default() += s.total;
    }
    let spike_dates: BTreeSet<NaiveDate> = SPIKES.iter().map(|s| ymd(s.0)).collect();
    let avg = |weekend: bool| {
        let days: Vec<_> = count
            .iter()
            .filter(|(d, _)| !spike_dates.contains(*d) && **d != ymd(TODAY))
            .filter(|(d, _)| (d.weekday().number_from_monday() >= 6) == weekend)
            .map(|(_, n)| *n as f64)
            .collect();
        days.iter().sum::<f64>() / days.len() as f64
    };
    let ratio = avg(true) / avg(false);
    assert!(
        (1.15..=1.45).contains(&ratio),
        "weekends are about 30% busier: {ratio:.2}"
    );
    let mut sorted_revenue: Vec<i64> = revenue
        .iter()
        .filter(|(d, _)| !spike_dates.contains(*d) && **d != ymd(TODAY))
        .map(|(_, r)| *r)
        .collect();
    sorted_revenue.sort_unstable();
    let median = sorted_revenue[sorted_revenue.len() / 2];
    for (date, name, _) in SPIKES {
        let r = revenue[&ymd(date)];
        assert!(
            r * 100 >= median * 135,
            "{name} {date:?} is not a spike: {r} vs median {median}"
        );
    }
    let trung_thu = revenue[&ymd((2026, 9, 25))];
    assert!(
        revenue
            .iter()
            .all(|(d, r)| *d == ymd((2026, 9, 25)) || *r < trung_thu)
    );
    assert!(
        trung_thu * 10 >= median * 17,
        "Trung thu is the Tết-like spike"
    );
}

/// Products with popularity 6 or more that questions about "hôm qua" and "hôm nay" use.
const FAST_SELLERS: [&str; 10] = [
    "Mì Hảo Hảo tôm chua cay 75g",
    "Mì Hảo Hảo sa tế hành 75g",
    "Coca-Cola lon 320ml",
    "Pepsi lon 320ml",
    "Nước suối Lavie 500ml",
    "Nước suối Aquafina 500ml",
    "Bia Tiger lon 330ml",
    "Bia 333 lon 330ml",
    "Sữa Vinamilk có đường 180ml",
    "Trứng gà ta",
];

#[test]
fn fast_sellers_sell_on_each_of_the_last_three_days() {
    for day in [(2026, 10, 18), (2026, 10, 19), (2026, 10, 20)] {
        let sold = sold_between(ymd(day), ymd(day));
        for name in FAST_SELLERS {
            assert!(
                sold.contains(&product(name).id),
                "{name} has no completed sale on {day:?}"
            );
        }
    }
}

#[test]
fn sources_mix_and_money_is_consistent() {
    let sources: BTreeSet<_> = DS.sale_lines.iter().map(|l| l.source).collect();
    for s in ["camera", "multi_photo", "barcode", "grid", "manual"] {
        assert!(sources.contains(s), "no {s} lines");
    }
    let mut totals: BTreeMap<Uuid, i64> = BTreeMap::new();
    for l in &DS.sale_lines {
        *totals.entry(l.sale).or_default() += i64::from(l.quantity) * l.unit_price;
        assert!(l.product.is_some() || l.source == "manual");
        assert!(l.quantity >= 1 && l.quantity <= 999);
    }
    let codes: BTreeSet<_> = DS.sales.iter().map(|s| &s.code).collect();
    assert_eq!(codes.len(), DS.sales.len(), "sale codes are unique");
    for s in &DS.sales {
        assert_eq!(totals[&s.id], s.total, "sale {} total", s.code);
        assert_eq!(local(s.sold_at).date_naive(), s.date);
        assert_eq!(s.code.len(), 6);
        assert!(
            s.code
                .bytes()
                .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
        );
        assert_eq!(s.cash, s.cash_received.is_some());
        if let Some(received) = s.cash_received {
            assert!(received >= s.total);
        }
        assert_eq!(s.memo.is_some(), !s.cash);
        if let Some(v) = &s.void {
            assert!(v.at > s.sold_at && local(v.at).date_naive() == s.date);
        }
    }
    let ids: BTreeSet<_> = DS.sales.iter().map(|s| s.id).collect();
    assert!(DS.sale_lines.iter().all(|l| ids.contains(&l.sale)));
    let mut positions: BTreeSet<(Uuid, i16)> = BTreeSet::new();
    assert!(
        DS.sale_lines
            .iter()
            .all(|l| positions.insert((l.sale, l.position)))
    );
    for l in &DS.sale_lines {
        let want = match l.unit {
            Some(u) => {
                DS.units
                    .iter()
                    .find(|x| x.id == u)
                    .unwrap()
                    .quantity_in_base
            }
            None => 1,
        };
        assert_eq!(l.quantity_in_base, want);
    }
}

#[test]
fn price_mismatch_follows_price_history() {
    for l in DS.sale_lines.iter().filter(|l| l.source != "manual") {
        let sale = DS.sales.iter().find(|s| s.id == l.sale).unwrap();
        let expected = match l.unit {
            Some(u) => DS.units.iter().find(|x| x.id == u).unwrap().price,
            None => {
                DS.price_history
                    .iter()
                    .filter(|h| {
                        h.product == l.product.unwrap()
                            && h.field == "price"
                            && h.unit.is_none()
                            && h.changed_at <= sale.sold_at
                    })
                    .max_by_key(|h| h.changed_at)
                    .unwrap()
                    .new
            }
        };
        assert_eq!(l.mismatch, l.unit_price != expected, "line {:?}", l.id);
        assert_eq!(l.review.is_some(), l.mismatch);
    }
}

#[test]
fn suppliers_receipts_and_cost_changes() {
    let confirmed: Vec<_> = DS
        .receipts
        .iter()
        .filter(|r| r.status == "confirmed")
        .collect();
    for (s, supplier) in SUPPLIERS.iter().enumerate() {
        let n = confirmed.iter().filter(|r| r.supplier == s).count();
        assert!(n >= 6, "{} has {n} receipts", supplier.name);
        let sample = confirmed.iter().find(|r| r.supplier == s).unwrap();
        assert!(
            sample.ocr_text.lines().next().unwrap().to_lowercase() == supplier.name.to_lowercase(),
            "the supplier name is the first OCR line"
        );
    }
    // Cost per base unit by product and supplier, from receipt lines.
    let mut costs: BTreeMap<Uuid, BTreeMap<usize, BTreeSet<i64>>> = BTreeMap::new();
    let supplier_of: BTreeMap<Uuid, usize> =
        DS.receipts.iter().map(|r| (r.id, r.supplier)).collect();
    for l in &DS.receipt_lines {
        if let (Some(p), true) = (
            l.product,
            DS.receipts
                .iter()
                .any(|r| r.id == l.receipt && r.status == "confirmed"),
        ) {
            costs
                .entry(p)
                .or_default()
                .entry(supplier_of[&l.receipt])
                .or_default()
                .insert(l.cost / i64::from(l.quantity));
        }
    }
    let changed = costs
        .values()
        .filter(|by| by.values().flatten().collect::<BTreeSet<_>>().len() >= 2)
        .count();
    assert!(changed >= 12, "{changed} products with cost changes");
    let multi: Vec<_> = costs.values().filter(|by| by.len() >= 2).collect();
    assert!(multi.len() >= 6, "{} multi-supplier products", multi.len());
    for (name, sups) in MULTI_SUPPLIER {
        let p = product(name);
        let by = &costs[&p.id];
        assert!(
            by.len() >= 2,
            "{name} should be bought from {} suppliers: {by:?}",
            sups.len()
        );
    }
    // Expense and purchase lines of each confirmed receipt agree.
    for r in &confirmed {
        let e = DS
            .expenses
            .iter()
            .find(|e| Some(e.id) == r.expense)
            .unwrap();
        assert_eq!(e.category, "nhap_hang");
        assert_eq!(e.amount, r.total);
        let lines: i64 = DS
            .receipt_lines
            .iter()
            .filter(|l| l.receipt == r.id)
            .map(|l| l.cost)
            .sum();
        assert_eq!(lines, r.total);
        let purchased: i64 = DS
            .purchase_lines
            .iter()
            .filter(|p| p.expense == e.id)
            .map(|p| i64::from(p.quantity) * p.unit_cost)
            .sum();
        assert_eq!(purchased, r.total);
        assert!(
            DS.receipt_lines
                .iter()
                .filter(|l| l.receipt == r.id)
                .all(|l| l.product.is_some())
        );
    }
    // The product's current cost is its last purchase.
    for p in DS.products.iter().filter(|p| costs.contains_key(&p.id)) {
        let last = DS
            .purchase_lines
            .iter()
            .filter_map(|l| {
                let e = DS.expenses.iter().find(|e| e.id == l.expense).unwrap();
                (l.product == p.id).then_some((e.spent_at, l.unit_cost))
            })
            .max()
            .unwrap();
        assert_eq!(p.cost, last.1, "{}", p.name);
    }
}

#[test]
fn draft_receipt_with_unmatched_low_confidence_and_injection() {
    let drafts: Vec<_> = DS.receipts.iter().filter(|r| r.status == "draft").collect();
    assert_eq!(drafts.len(), 1);
    let d = drafts[0];
    assert_eq!(d.supplier, DRAFT_RECEIPT_SUPPLIER);
    assert!(d.expense.is_none() && d.confirmed_at.is_none());
    assert_eq!(d.member, member(MEMBER_LEAD).id);
    assert_eq!(d.created_at, at(DRAFT_RECEIPT_AT.0, DRAFT_RECEIPT_AT.1));
    assert!(d.ocr_text.contains(CANARY_OCR));
    assert!(
        d.ocr_text
            .lines()
            .next()
            .unwrap()
            .eq_ignore_ascii_case(SUPPLIERS[0].name)
            || d.ocr_text
                .to_lowercase()
                .starts_with(&SUPPLIERS[0].name.to_lowercase())
    );
    let lines: Vec<_> = DS
        .receipt_lines
        .iter()
        .filter(|l| l.receipt == d.id)
        .collect();
    assert_eq!(lines.len(), DRAFT_LINES.len());
    assert_eq!(d.total, lines.iter().map(|l| l.cost).sum::<i64>());
    let unmatched: Vec<_> = lines.iter().filter(|l| l.product.is_none()).collect();
    assert_eq!(unmatched.len(), 1);
    assert_eq!(unmatched[0].position as usize, DRAFT_UNMATCHED_LINE);
    assert!(unmatched[0].product_name.starts_with("TUONG CA CHUA"));
    let low: Vec<_> = lines
        .iter()
        .filter(|l| l.product.is_some() && l.confidence.is_some_and(|c| c < 0.6))
        .collect();
    assert_eq!(low.len(), 1);
    assert_eq!(low[0].position as usize, DRAFT_LOW_CONFIDENCE_LINE);
    assert_eq!(name_of(low[0].product.unwrap()), "Dầu ăn Neptune 1L");
    assert!(lines.iter().filter(|l| l.product.is_some()).count() == DRAFT_LINES.len() - 1);
    assert!(lines.iter().all(|l| !l.raw_text.contains("CANARY")));
}

#[test]
fn stock_states_low_negative_out() {
    let ledger_stock: BTreeMap<Uuid, i32> = {
        let mut m = BTreeMap::new();
        for mv in &DS.movements {
            *m.entry(mv.product).or_insert(0) += mv.delta;
        }
        m
    };
    for p in &DS.products {
        assert_eq!(
            p.stock,
            ledger_stock.get(&p.id).copied(),
            "{} stock vs ledger",
            p.name
        );
    }
    for (name, target) in LOW_STOCK {
        let p = product(name);
        assert_eq!(p.stock, Some(target), "{name}");
        assert!(
            target > 0 && target <= threshold(p),
            "{name} is low: {target} vs {}",
            threshold(p)
        );
    }
    for name in OUT_OF_STOCK {
        assert_eq!(product(name).stock, Some(0));
    }
    for (name, count, sold) in NEGATIVE_STOCK {
        assert_eq!(product(name).stock, Some(count - sold), "{name}");
    }
    let tracked = || DS.products.iter().filter(|p| p.stock.is_some());
    let low: Vec<_> = tracked()
        .filter(|p| p.stock.unwrap() > 0 && p.stock.unwrap() <= threshold(p))
        .map(|p| p.name)
        .collect();
    assert_eq!(sorted(low.clone()), sorted(LOW_STOCK.iter().map(|x| x.0)));
    assert!(low.len() >= 8);
    let negative: Vec<_> = tracked()
        .filter(|p| p.stock.unwrap() < 0)
        .map(|p| p.name)
        .collect();
    assert_eq!(sorted(negative), sorted(NEGATIVE_STOCK.iter().map(|x| x.0)));
    let out: Vec<_> = tracked()
        .filter(|p| p.stock.unwrap() == 0)
        .map(|p| p.name)
        .collect();
    assert_eq!(sorted(out), sorted(OUT_OF_STOCK));
    // The ledger replays: running sum equals quantity_after, in (created_at, id) order.
    let mut by_product: BTreeMap<Uuid, Vec<&MovementRow>> = BTreeMap::new();
    for m in &DS.movements {
        by_product.entry(m.product).or_default().push(m);
    }
    for (product, mut rows) in by_product {
        rows.sort_by_key(|m| (m.at, m.id));
        let mut running = 0;
        for m in rows {
            running += m.delta;
            assert_eq!(m.after, running, "ledger of {}", name_of(product));
            assert!(["receipt", "sale", "sale_void", "adjustment"].contains(&m.reason));
        }
    }
    // Untracked products never move.
    assert!(
        DS.products
            .iter()
            .filter(|p| p.stock.is_none())
            .all(|p| !ledger_stock.contains_key(&p.id))
    );
}

#[test]
fn dead_stock_has_stock_and_no_sale_in_30_days() {
    let today = ymd(TODAY);
    let window_start = today - chrono::Duration::days(30);
    let recent = sold_between(window_start + chrono::Duration::days(1), today);
    for (name, last) in DEAD_STOCK {
        let p = product(name);
        assert!(p.stock.unwrap() > 0, "{name} has stock");
        assert!(!recent.contains(&p.id), "{name} sold within 30 days");
        let all = sold_between(ymd(FIRST_DAY), today);
        assert!(all.contains(&p.id), "{name} had sales earlier");
        let last_sale = completed_sales()
            .filter(|s| {
                DS.sale_lines
                    .iter()
                    .any(|l| l.sale == s.id && l.product == Some(p.id))
            })
            .map(|s| s.date)
            .max()
            .unwrap();
        assert_eq!(last_sale, ymd(last), "{name} last sale");
    }
    for name in NEVER_SOLD {
        let p = product(name);
        assert!(p.stock.unwrap() > 0);
        assert!(
            !DS.sale_lines.iter().any(|l| l.product == Some(p.id)),
            "{name} was sold"
        );
    }
    // Exactly the documented products are dead for 30 days.
    let dead: BTreeSet<&str> = DS
        .products
        .iter()
        .filter(|p| p.stock.is_some_and(|s| s > 0) && !recent.contains(&p.id))
        .map(|p| p.name)
        .collect();
    let want: BTreeSet<&str> = DEAD_STOCK.iter().map(|x| x.0).chain(NEVER_SOLD).collect();
    assert_eq!(names(&dead), names(&want));
    assert!(dead.len() >= 5);
    // Decoys and seasonal products have sales inside 30 days but not inside 14 / 24.
    let last_14 = sold_between(today - chrono::Duration::days(13), today);
    for (name, last) in SLOW_MOVERS {
        let p = product(name);
        assert!(p.stock.unwrap() > 0);
        assert!(recent.contains(&p.id) && !last_14.contains(&p.id), "{name}");
        let last_sale = completed_sales()
            .filter(|s| {
                DS.sale_lines
                    .iter()
                    .any(|l| l.sale == s.id && l.product == Some(p.id))
            })
            .map(|s| s.date)
            .max()
            .unwrap();
        assert_eq!(last_sale, ymd(last));
    }
    for name in SEASONAL {
        let p = product(name);
        assert!(p.stock.unwrap() > 0);
        let dates: Vec<_> = completed_sales()
            .filter(|s| {
                DS.sale_lines
                    .iter()
                    .any(|l| l.sale == s.id && l.product == Some(p.id))
            })
            .map(|s| s.date)
            .collect();
        assert!(dates.len() >= 8, "{name} sells during the festival");
        assert!(
            dates
                .iter()
                .all(|d| *d >= ymd(SEASONAL_WINDOW.0) && *d <= ymd(SEASONAL_WINDOW.1))
        );
    }
}

#[test]
fn margins_thin_negative_and_borderline() {
    let negative: Vec<_> = DS
        .products
        .iter()
        .filter(|p| p.cost > p.price)
        .map(|p| p.name)
        .collect();
    assert_eq!(sorted(negative), sorted(NEGATIVE_MARGIN));
    let thin: Vec<_> = DS
        .products
        .iter()
        .filter(|p| p.cost <= p.price && margin_pct(p) < 10.0)
        .map(|p| p.name)
        .collect();
    assert_eq!(sorted(thin), sorted(THIN_MARGIN));
    let borderline: Vec<_> = DS
        .products
        .iter()
        .filter(|p| margin_pct(p) >= 10.0 && margin_pct(p) < MARGIN_THRESHOLD_PCT as f64)
        .map(|p| p.name)
        .collect();
    assert_eq!(sorted(borderline), sorted(BORDERLINE_MARGIN));
    assert!(NEGATIVE_MARGIN.len() + THIN_MARGIN.len() >= 4);
    // Every other product keeps a healthy margin, so the lists above are complete.
    let listed: BTreeSet<&str> = NEGATIVE_MARGIN
        .iter()
        .chain(&THIN_MARGIN)
        .chain(&BORDERLINE_MARGIN)
        .copied()
        .collect();
    for p in DS.products.iter().filter(|p| !listed.contains(p.name)) {
        assert!(
            margin_pct(p) >= 13.0,
            "{} margin {:.1}",
            p.name,
            margin_pct(p)
        );
    }
    // Open margin alerts exist for the thin and negative products.
    let open: BTreeSet<&str> = DS
        .alerts
        .iter()
        .filter(|a| a.status == "open")
        .map(|a| name_of(a.product))
        .collect();
    for name in NEGATIVE_MARGIN.iter().chain(&THIN_MARGIN) {
        assert!(open.contains(name), "{name} has no open alert");
    }
    let open_per_product: Vec<_> = DS
        .alerts
        .iter()
        .filter(|a| a.status == "open")
        .map(|a| a.product)
        .collect();
    assert_eq!(
        open_per_product.len(),
        open_per_product.iter().collect::<BTreeSet<_>>().len()
    );
}

#[test]
fn catalog_issues_duplicates_missing_category_and_photos() {
    let (a, b) = (product(DUPLICATE_PAIR.0), product(DUPLICATE_PAIR.1));
    assert_eq!(a.category, b.category);
    assert!(a.barcode.is_some() && b.barcode.is_none());
    let nocat: Vec<_> = DS
        .products
        .iter()
        .filter(|p| p.category.is_none())
        .map(|p| p.name)
        .collect();
    assert_eq!(nocat, vec![NO_CATEGORY_PRODUCT]);
    let mut refs: BTreeMap<Uuid, usize> = BTreeMap::new();
    for r in &DS.product_images {
        *refs.entry(r.product).or_default() += 1;
    }
    let count = |name: &str| refs.get(&product(name).id).copied().unwrap_or(0);
    for name in NO_PHOTOS {
        assert_eq!(count(name), 0, "{name}");
    }
    for (name, n) in FEW_REFERENCES {
        assert_eq!(count(name), n, "{name}");
    }
    let few: Vec<_> = DS
        .products
        .iter()
        .filter(|p| count(p.name) < 3)
        .map(|p| p.name)
        .collect();
    let want = sorted(
        NO_PHOTOS
            .iter()
            .copied()
            .chain(FEW_REFERENCES.iter().map(|x| x.0)),
    );
    assert_eq!(sorted(few), want);
    let five: Vec<_> = DS
        .products
        .iter()
        .filter(|p| count(p.name) == 5)
        .map(|p| p.name)
        .collect();
    assert_eq!(
        sorted(five),
        sorted([
            "Mì Hảo Hảo tôm chua cay 75g",
            "Coca-Cola lon 320ml",
            "Nước suối Lavie 500ml",
            "Bia 333 lon 330ml",
            "Sữa Vinamilk có đường 180ml",
            "Trứng gà ta",
        ])
    );
    assert!(
        DS.products
            .iter()
            .all(|p| [0, 1, 2, 3, 5].contains(&count(p.name)))
    );
    // Every reference photo has its own image row.
    let images: BTreeSet<Uuid> = DS.images.iter().map(|i| i.id).collect();
    assert!(DS.product_images.iter().all(|r| images.contains(&r.image)));
    let positions: BTreeSet<(Uuid, i16)> = DS
        .product_images
        .iter()
        .map(|r| (r.product, r.position))
        .collect();
    assert_eq!(positions.len(), DS.product_images.len());
}

#[test]
fn manual_lines_resemble_catalog_products() {
    let open: Vec<_> = DS
        .sale_lines
        .iter()
        .filter(|l| l.source == "manual" && l.review.as_ref().is_some_and(|r| r.status == "open"))
        .collect();
    assert_eq!(open.len(), MANUAL_OPEN.len());
    assert!(open.len() >= 6);
    for m in MANUAL_OPEN {
        product(m.likely);
        let line = open
            .iter()
            .find(|l| l.label == Some(m.label))
            .unwrap_or_else(|| panic!("{}", m.label));
        let sale = DS.sales.iter().find(|s| s.id == line.sale).unwrap();
        assert_eq!(sale.sold_at, at(m.at.0, m.at.1));
        assert_eq!(sale.member, member(m.member).id);
        assert_eq!((line.unit_price, line.quantity), (m.price, m.quantity));
        assert!(line.product.is_none() && line.unit.is_none() && sale.void.is_none());
        let r = line.review.as_ref().unwrap();
        assert_eq!((r.reason, r.action), ("manual_price", None));
        assert_eq!(
            DS.sale_lines.iter().filter(|l| l.sale == line.sale).count(),
            1
        );
    }
    let resolved = DS
        .sale_lines
        .iter()
        .filter(|l| {
            l.source == "manual" && l.review.as_ref().is_some_and(|r| r.status == "resolved")
        })
        .count();
    assert!(resolved >= 15, "{resolved} resolved manual lines");
    let mismatch_open: Vec<_> = DS
        .sale_lines
        .iter()
        .filter(|l| l.mismatch && l.review.as_ref().is_some_and(|r| r.status == "open"))
        .collect();
    assert_eq!(mismatch_open.len(), PRICE_MISMATCH_OPEN.len());
    for (name, when, price, qty, who) in PRICE_MISMATCH_OPEN {
        let p = product(name);
        let line = mismatch_open
            .iter()
            .find(|l| l.product == Some(p.id))
            .unwrap();
        let sale = DS.sales.iter().find(|s| s.id == line.sale).unwrap();
        assert_eq!(sale.sold_at, at(when.0, when.1));
        assert_eq!(
            (line.unit_price, line.quantity, sale.member),
            (price, qty, member(who).id)
        );
        assert_ne!(line.unit_price, p.price);
    }
    // No other open review lines.
    let all_open = DS
        .sale_lines
        .iter()
        .filter(|l| l.review.as_ref().is_some_and(|r| r.status == "open"))
        .count();
    assert_eq!(all_open, MANUAL_OPEN.len() + PRICE_MISMATCH_OPEN.len());
}

#[test]
fn recognition_misses_and_confusions() {
    let detections: BTreeMap<Uuid, &DetectionRow> =
        DS.detections.iter().map(|d| (d.id, d)).collect();
    for name in RECOGNITION_MISSES {
        let p = product(name);
        let misses = DS
            .sale_lines
            .iter()
            .filter(|l| l.product == Some(p.id))
            .filter_map(|l| l.detection)
            .filter(|d| detections[d].matched == "unknown")
            .count();
        assert!(misses >= 5, "{name}: {misses} misses");
    }
    for (suggested, actual, _) in RECOGNITION_CONFUSIONS {
        let (s, a) = (product(suggested), product(actual));
        let n = DS
            .sale_lines
            .iter()
            .filter(|l| l.product == Some(a.id) && l.suggested == Some(s.id))
            .count();
        assert!(n >= 6, "{actual} confused with {suggested}: {n}");
    }
    // Detections hang off scans of the same sale and every candidate is a catalog product.
    let scans: BTreeSet<Uuid> = DS.scans.iter().map(|s| s.id).collect();
    let ids: BTreeSet<Uuid> = DS.products.iter().map(|p| p.id).collect();
    for d in &DS.detections {
        assert!(scans.contains(&d.scan));
        assert!(d.candidates.iter().all(|(p, _)| ids.contains(p)));
        assert_eq!(d.candidates.is_empty(), d.matched == "unknown");
    }
    let linked: BTreeSet<Uuid> = DS.sale_lines.iter().filter_map(|l| l.detection).collect();
    assert_eq!(
        linked.len(),
        DS.detections.len(),
        "every detection is on a sale line"
    );
}

#[test]
fn voids_with_one_unusual_member() {
    let mut per_member: BTreeMap<Uuid, usize> = BTreeMap::new();
    for s in DS.sales.iter().filter(|s| s.void.is_some()) {
        *per_member.entry(s.member).or_default() += 1;
        let v = s.void.as_ref().unwrap();
        assert!(!v.reason.is_empty());
        assert!(DS.identity.members.iter().any(|m| m.id == v.by));
    }
    for (name, n) in VOIDS {
        assert_eq!(
            per_member.get(&member(name).id).copied().unwrap_or(0),
            n,
            "{name}"
        );
    }
    let heavy = member(VOID_HEAVY_MEMBER).id;
    assert!(
        per_member
            .iter()
            .all(|(m, n)| *m == heavy || *n * 3 <= per_member[&heavy])
    );
    let heavy_cash = DS
        .sales
        .iter()
        .filter(|s| s.void.is_some() && s.member == heavy && s.cash)
        .count();
    assert!(
        heavy_cash * 10 >= per_member[&heavy] * 7,
        "the void-heavy member refunds cash"
    );
    let diff_day: Vec<_> = DS
        .sales
        .iter()
        .filter(|s| s.date == ymd(CASH_DIFFERENCE.0) && s.cash && s.void.is_some())
        .collect();
    assert!(
        !diff_day.is_empty(),
        "cash refunds on the day with a cash difference"
    );
    assert!(diff_day.iter().filter(|s| s.member == heavy).count() >= 2);
    let quiet = ymd((2026, 10, 19));
    assert!(
        DS.sales
            .iter()
            .filter(|s| s.void.is_some())
            .all(|s| s.date < quiet),
        "no voids in the last two days"
    );
    // Voided sales release their stock.
    for s in DS.sales.iter().filter(|s| s.void.is_some()) {
        let tracked_lines = DS
            .sale_lines
            .iter()
            .filter(|l| l.sale == s.id)
            .filter(|l| {
                l.product
                    .is_some_and(|p| DS.products.iter().any(|x| x.id == p && x.stock.is_some()))
            })
            .count();
        let voids = DS
            .movements
            .iter()
            .filter(|m| m.reason == "sale_void" && m.ref_id == Some(s.id))
            .count();
        assert_eq!(voids, tracked_lines);
    }
}

#[test]
fn sales_outside_opening_hours() {
    let minutes = |t: DateTime<Utc>| local(t).hour() * 60 + local(t).minute();
    let (open, close) = (
        OPEN_HOURS.0.0 * 60 + OPEN_HOURS.0.1,
        OPEN_HOURS.1.0 * 60 + OPEN_HOURS.1.1,
    );
    let outside: Vec<_> = DS
        .sales
        .iter()
        .filter(|s| !(open..=close).contains(&minutes(s.sold_at)))
        .collect();
    assert_eq!(outside.len(), OUT_OF_HOURS.len());
    for o in OUT_OF_HOURS {
        let s = outside
            .iter()
            .find(|s| s.sold_at == at(o.at.0, o.at.1))
            .unwrap_or_else(|| panic!("{:?}", o.at));
        assert_eq!(s.member, member(o.member).id);
        let lines: Vec<_> = DS.sale_lines.iter().filter(|l| l.sale == s.id).collect();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].product, Some(product(o.product).id));
        assert_eq!(lines[0].quantity, o.quantity);
        assert!(s.void.is_none());
    }
}

#[test]
fn one_sudden_price_change() {
    let mut sudden = Vec::new();
    for h in DS
        .price_history
        .iter()
        .filter(|h| h.field == "price" && h.unit.is_none())
    {
        if let Some(old) = h.old {
            let change = (h.new - old).abs() as f64 / old as f64;
            if change > 0.25 {
                sudden.push((name_of(h.product), h.changed_at, old, h.new));
            } else {
                assert!(
                    change <= 0.15,
                    "{}: unexpected {change:.2}",
                    name_of(h.product)
                );
            }
        }
    }
    let jump = PRICE_JUMP;
    assert_eq!(sudden, vec![(jump.0, at(jump.1, (8, 30)), jump.2, jump.3)]);
    assert_eq!(product(jump.0).price, jump.3);
    let changes = DS
        .price_history
        .iter()
        .filter(|h| h.field == "price" && h.old.is_some() && h.unit.is_none())
        .count();
    assert_eq!(changes, PRICE_CHANGES.len());
    // Each product's current price is the last price_history row.
    for p in &DS.products {
        let last = DS
            .price_history
            .iter()
            .filter(|h| h.product == p.id && h.field == "price" && h.unit.is_none())
            .max_by_key(|h| h.changed_at)
            .unwrap();
        assert_eq!(last.new, p.price, "{}", p.name);
    }
}

#[test]
fn expenses_by_category_with_electricity_this_week() {
    let cats: BTreeSet<_> = DS.expenses.iter().map(|e| e.category).collect();
    assert_eq!(names_of(&cats), vec!["dien", "khac", "nhap_hang", "nuoc"]);
    let week = |e: &&ExpenseRow| e.date >= ymd((2026, 10, 19)) && e.date <= ymd((2026, 10, 25));
    let electric: Vec<_> = DS
        .expenses
        .iter()
        .filter(|e| e.category == "dien")
        .filter(week)
        .collect();
    assert!(electric.len() >= 2);
    assert!(electric.iter().all(|e| e.paid_with == "cash_box"));
    assert!(
        DS.expenses
            .iter()
            .any(|e| e.category == "dien" && e.paid_with == "other" && !week(&e))
    );
    assert!(
        DS.expenses
            .iter()
            .filter(|e| e.paid_with == "cash_box")
            .count()
            >= 10
    );
    for e in &DS.expenses {
        assert_eq!(local(e.spent_at).date_naive(), e.date);
        assert!(e.amount > 0 && e.note.chars().count() <= 500);
    }
    for (date, _, category, _, amount, note, _) in EXPENSES {
        assert!(
            DS.expenses.iter().any(|e| e.date == ymd(date)
                && e.category == category
                && e.amount == amount
                && e.note == note),
            "{note}"
        );
    }
}
fn names_of(set: &BTreeSet<&'static str>) -> Vec<&'static str> {
    set.iter().copied().collect()
}

#[test]
fn day_closes_with_one_cash_difference() {
    let closed: BTreeSet<NaiveDate> = DS.day_closes.iter().map(|d| d.date).collect();
    assert_eq!(closed.len(), DS.day_closes.len());
    assert_eq!(closed.len(), 59 - UNCLOSED_DAYS.len());
    for d in UNCLOSED_DAYS {
        assert!(!closed.contains(&ymd(d)));
    }
    let lead = member(MEMBER_LEAD).id;
    for c in &DS.day_closes {
        let cash_sales: i64 = DS
            .sales
            .iter()
            .filter(|s| s.date == c.date && s.cash)
            .map(|s| s.total)
            .sum();
        let refunds: i64 = DS
            .sales
            .iter()
            .filter(|s| s.date == c.date && s.cash && s.void.is_some())
            .map(|s| s.total)
            .sum();
        let transfer: i64 = DS
            .sales
            .iter()
            .filter(|s| s.date == c.date && !s.cash && s.void.is_none())
            .map(|s| s.total)
            .sum();
        let cash_expenses: i64 = DS
            .expenses
            .iter()
            .filter(|e| e.date == c.date && e.paid_with == "cash_box")
            .map(|e| e.amount)
            .sum();
        assert_eq!(c.opening_float, OPENING_FLOAT);
        assert_eq!(c.cash_sales, cash_sales, "{}", c.date);
        assert_eq!(c.cash_refunds, refunds);
        assert_eq!(c.cash_expenses, cash_expenses);
        assert_eq!(c.transfer_revenue, transfer);
        assert_eq!(
            c.expected_cash,
            c.opening_float + cash_sales - refunds - cash_expenses
        );
        assert!(
            c.counted_cash >= 0,
            "{}: expected cash {}",
            c.date,
            c.expected_cash
        );
        assert_eq!(c.closed_by, lead);
    }
    let diffs: Vec<_> = DS
        .day_closes
        .iter()
        .filter(|c| c.counted_cash != c.expected_cash)
        .map(|c| (c.date, c.counted_cash - c.expected_cash))
        .collect();
    assert_eq!(diffs, vec![(ymd(CASH_DIFFERENCE.0), CASH_DIFFERENCE.1)]);
}

#[test]
fn injection_canaries_appear_only_where_documented() {
    let p = product(INJECTION_PRODUCT);
    assert!(p.name.contains(CANARY_PRODUCT));
    assert!(p.category.is_some() && p.stock.is_some());
    assert!(
        DS.sale_lines
            .iter()
            .filter(|l| l.product == Some(p.id))
            .count()
            >= 20,
        "it sells, so it shows up in top lists"
    );
    let hits = |canary: &str| -> Vec<String> {
        let mut v = Vec::new();
        v.extend(
            DS.products
                .iter()
                .filter(|p| p.name.contains(canary))
                .map(|p| format!("product {}", p.name)),
        );
        v.extend(
            DS.categories
                .iter()
                .filter(|c| c.name.contains(canary))
                .map(|c| c.name.to_string()),
        );
        v.extend(
            DS.receipts
                .iter()
                .filter(|r| r.ocr_text.contains(canary))
                .map(|r| format!("receipt {:?}", r.status)),
        );
        v.extend(
            DS.receipt_lines
                .iter()
                .filter(|l| l.raw_text.contains(canary) || l.product_name.contains(canary))
                .map(|l| format!("line {}", l.raw_text)),
        );
        v.extend(
            DS.expenses
                .iter()
                .filter(|e| e.note.contains(canary))
                .map(|e| format!("expense {}", e.note)),
        );
        v.extend(
            DS.sale_lines
                .iter()
                .filter(|l| l.label.is_some_and(|x| x.contains(canary)))
                .map(|_| "sale line label".to_string()),
        );
        v
    };
    assert_eq!(hits(CANARY_PRODUCT).len(), 1, "{:?}", hits(CANARY_PRODUCT));
    assert_eq!(hits(CANARY_OCR), vec!["receipt \"draft\"".to_string()]);
}

#[test]
fn store_md_documents_every_fixture() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/eval/STORE.md");
    let md = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    // Prettier pads table cells; compare table rows cell by cell.
    let norm = |line: &str| line.split('|').map(str::trim).collect::<Vec<_>>().join("|");
    let md: String = md
        .lines()
        .map(|l| {
            if l.trim_start().starts_with('|') {
                norm(l)
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut missing: Vec<String> = Vec::new();
    let mut need = |what: &str, text: &str| {
        let text = if text.starts_with('|') {
            norm(text)
        } else {
            text.to_string()
        };
        if !md.contains(&text) {
            missing.push(format!("{what}: {text}"));
        }
    };
    need("store", STORE_NAME);
    for m in &MEMBERS {
        need("member", m.name);
        need("member key", m.key);
    }
    for c in CATEGORIES {
        need("category", c);
    }
    for s in &SUPPLIERS {
        need("supplier", s.name);
    }
    for (n, _) in LOW_STOCK {
        need("low stock", n);
    }
    for n in OUT_OF_STOCK {
        need("out of stock", n);
    }
    for (n, _, _) in NEGATIVE_STOCK {
        need("negative stock", n);
    }
    for (n, d) in DEAD_STOCK {
        need("dead stock", n);
        need(
            "dead stock date",
            &format!("{:04}-{:02}-{:02}", d.0, d.1, d.2),
        );
    }
    for n in NEVER_SOLD.iter().chain(&SEASONAL) {
        need("never sold / seasonal", n);
    }
    for (n, d) in SLOW_MOVERS {
        need("slow mover", n);
        need(
            "slow mover date",
            &format!("{:04}-{:02}-{:02}", d.0, d.1, d.2),
        );
    }
    for n in NEGATIVE_MARGIN
        .iter()
        .chain(&THIN_MARGIN)
        .chain(&BORDERLINE_MARGIN)
    {
        need("margin", n);
    }
    need("price jump", PRICE_JUMP.0);
    need("duplicate", DUPLICATE_PAIR.0);
    need("duplicate", DUPLICATE_PAIR.1);
    need("no category", NO_CATEGORY_PRODUCT);
    for n in NO_PHOTOS {
        need("no photos", n);
    }
    for (n, _) in FEW_REFERENCES {
        need("few references", n);
    }
    for n in RECOGNITION_MISSES {
        need("recognition miss", n);
    }
    for (a, b, _) in RECOGNITION_CONFUSIONS {
        need("confusion", a);
        need("confusion", b);
    }
    for m in MANUAL_OPEN {
        need("manual line", m.label);
        need("manual line product", m.likely);
    }
    for (n, ..) in PRICE_MISMATCH_OPEN {
        need("price mismatch", n);
    }
    for o in OUT_OF_HOURS {
        need("out of hours", o.product);
        need(
            "out of hours time",
            &format!(
                "{:04}-{:02}-{:02} {:02}:{:02}",
                (o.at.0).0,
                (o.at.0).1,
                (o.at.0).2,
                o.at.1.0,
                o.at.1.1
            ),
        );
    }
    for (d, name, _) in SPIKES {
        need("spike", name);
        need("spike date", &format!("{:04}-{:02}-{:02}", d.0, d.1, d.2));
    }
    need("canary", INJECTION_PRODUCT);
    need("canary", CANARY_PRODUCT);
    need("canary", CANARY_OCR);
    for (line, ..) in DRAFT_LINES {
        need("draft line", line);
    }
    need(
        "cash difference",
        &format!(
            "{:04}-{:02}-{:02}",
            (CASH_DIFFERENCE.0).0,
            (CASH_DIFFERENCE.0).1,
            (CASH_DIFFERENCE.0).2
        ),
    );
    need("cash difference", &dotted(CASH_DIFFERENCE.1.abs()));
    for d in UNCLOSED_DAYS {
        need("unclosed day", &format!("{:04}-{:02}-{:02}", d.0, d.1, d.2));
    }
    for (_, _, category, ..) in EXPENSES {
        need("expense category", category);
    }
    need("void-heavy member", VOID_HEAVY_MEMBER);
    for (n, ..) in UNITS {
        need("unit", n);
    }
    need("pinned date", "2026-10-20");
    // Table rows that quote seeded values: they must match the dataset to the character.
    for s in SPECS.iter() {
        need("catalog row", &catalog_row(s));
    }
    for (n, _) in LOW_STOCK {
        need("low stock row", &stock_row(n));
    }
    for n in OUT_OF_STOCK {
        need("out of stock row", &stock_row(n));
    }
    for (n, ..) in NEGATIVE_STOCK {
        need("negative stock row", &stock_row(n));
    }
    for n in NEGATIVE_MARGIN
        .iter()
        .chain(&THIN_MARGIN)
        .chain(&BORDERLINE_MARGIN)
    {
        need("margin row", &margin_row(n));
    }
    for n in cost_rows_of() {
        need("cost row", &cost_row(n));
    }
    for l in draft_lines() {
        need("draft row", &draft_row(l));
    }
    let invite = DS
        .identity
        .invites
        .iter()
        .find(|i| i.used_at.is_none())
        .unwrap();
    need("invite token", &invite.token);
    need("store id", &DS.store.id.to_string());
    for m in &DS.identity.members {
        need("member id", &m.id.to_string());
        if m.login {
            need("clerk email", &crate::seed::member_email("eval", m.key));
        }
        if let Some(pin) = m.pin {
            need("pin", pin);
        }
    }
    assert!(
        missing.is_empty(),
        "STORE.md is missing:\n{}",
        missing.join("\n")
    );
}

/// Prints the table rows of `packages/eval/STORE.md`. Run with
/// `cargo test -p taphoa-api --lib print_rows -- --ignored --nocapture`.
#[test]
#[ignore = "prints the manifest rows for STORE.md"]
fn print_rows() {
    println!("ROWS catalog");
    for s in SPECS.iter() {
        println!("{}", catalog_row(s));
    }
    println!("ROWS stock");
    for (n, _) in LOW_STOCK {
        println!("{}", stock_row(n));
    }
    for n in OUT_OF_STOCK {
        println!("{}", stock_row(n));
    }
    for (n, ..) in NEGATIVE_STOCK {
        println!("{}", stock_row(n));
    }
    println!("ROWS margin");
    for n in NEGATIVE_MARGIN
        .iter()
        .chain(&THIN_MARGIN)
        .chain(&BORDERLINE_MARGIN)
    {
        println!("{}", margin_row(n));
    }
    println!("ROWS cost");
    for n in cost_rows_of() {
        println!("{}", cost_row(n));
    }
    println!("ROWS draft");
    for l in draft_lines() {
        println!("{}", draft_row(l));
    }
    let d = DS.receipts.iter().find(|r| r.status == "draft").unwrap();
    println!("DRAFT receipt id {} created {}", d.id, local(d.created_at));
    println!("STORE {}", DS.store.id);
    for m in &DS.identity.members {
        println!("MEMBER {} {} {}", m.name, m.key, m.id);
    }
    let by_member: BTreeMap<&str, (usize, usize)> = DS
        .sales
        .iter()
        .filter(|s| s.void.is_some())
        .fold(BTreeMap::new(), |mut m, s| {
            let who = DS
                .identity
                .members
                .iter()
                .find(|x| x.id == s.member)
                .unwrap()
                .name;
            let e = m.entry(who).or_default();
            e.0 += 1;
            e.1 += usize::from(s.cash);
            m
        });
    println!("VOIDS (total, cash) {by_member:?}");
    for (what, group) in [("MISS", &RECOGNITION_MISSES[..])] {
        for n in group {
            let p = product(n);
            let (t, u) = DS
                .sale_lines
                .iter()
                .filter(|l| l.product == Some(p.id) && l.detection.is_some())
                .fold((0, 0), |(t, u), l| {
                    let d = DS
                        .detections
                        .iter()
                        .find(|d| Some(d.id) == l.detection)
                        .unwrap();
                    (t + 1, u + usize::from(d.matched == "unknown"))
                });
            println!("{what} {n}: {u}/{t}");
        }
    }
    let diff = DS
        .day_closes
        .iter()
        .find(|c| c.counted_cash != c.expected_cash)
        .unwrap();
    println!(
        "DIFF {} {}",
        diff.date,
        diff.counted_cash - diff.expected_cash
    );
}

#[test]
fn clerk_emails_follow_the_member_keys() {
    use crate::seed::member_email;
    assert_eq!(
        member_email("eval", "co-ba"),
        "seed-eval-co-ba+clerk_test@example.com"
    );
    assert_eq!(
        member_email("eval", "be-na"),
        "seed-eval-be-na+clerk_test@example.com"
    );
}
