//! Receipts from three suppliers (with cost changes and products sold by several suppliers), the
//! expenses and purchase lines they confirm, margin alerts, and one draft receipt.
use super::build::*;
use super::catalog::*;
use super::model::*;
use crate::money;
use crate::seed::Prng;
use chrono::{DateTime, Datelike, Duration, Utc};
use serde_json::json;
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub(super) struct StockIn {
    pub product: Uuid,
    pub at: DateTime<Utc>,
    pub qty: i32,
    pub receipt: Uuid,
}

pub(super) struct SupplyOut {
    pub receipts: Vec<ReceiptRow>,
    pub receipt_lines: Vec<ReceiptLineRow>,
    /// The `nhap_hang` expenses of confirmed receipts.
    pub expenses: Vec<ExpenseRow>,
    pub purchase_lines: Vec<PurchaseLineRow>,
    /// `cost_price` history rows with a nil id; the caller numbers them.
    pub cost_history: Vec<PriceHistoryRow>,
    pub alerts: Vec<AlertRow>,
    pub final_cost: BTreeMap<Uuid, i64>,
    pub stock_in: Vec<StockIn>,
}

/// OCR-style product name: upper case, no diacritics. The supplier's invoice prints the plain
/// product, so the text after " - " in a catalog name (the injected instruction) is not on it.
fn ascii_upper(s: &str) -> String {
    s.split(" - ")
        .next()
        .unwrap_or(s)
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| match c {
            'đ' => 'd',
            'Đ' => 'D',
            c => c,
        })
        .collect::<String>()
        .to_uppercase()
}

/// Expected base units sold per day, in thousandths, from the popularity weights alone.
pub(super) fn expected_daily_milli(ctx: &Ctx, p: &Prod) -> u64 {
    56 * 1600 * u64::from(p.spec.weight) / ctx.total_weight
}

fn header(s: usize, number: &str, date: chrono::NaiveDate) -> Vec<String> {
    let sup = &SUPPLIERS[s];
    vec![
        sup.name.to_uppercase(),
        format!("ĐC: {}", sup.address),
        format!("ĐT: {}", sup.phone),
        format!("HÓA ĐƠN BÁN HÀNG - Số {number}"),
        format!("Ngày: {}", date.format("%d/%m/%Y")),
    ]
}

struct PlannedLine {
    product: usize,
    qty: i32,
    unit_cost: i64,
}

pub(super) fn generate(ctx: &Ctx, images: &mut Images) -> SupplyOut {
    let lead = ctx.members[0];
    let threshold_bp = i64::from(MARGIN_THRESHOLD_PCT) * 100;
    let mut out = SupplyOut {
        receipts: Vec::new(),
        receipt_lines: Vec::new(),
        expenses: Vec::new(),
        purchase_lines: Vec::new(),
        cost_history: Vec::new(),
        alerts: Vec::new(),
        final_cost: BTreeMap::new(),
        stock_in: Vec::new(),
    };
    let mut visits: Vec<(DateTime<Utc>, usize)> = Vec::new();
    let mut date = ymd((2026, 8, 24));
    while date <= ymd((2026, 10, 19)) {
        for (s, sup) in SUPPLIERS.iter().enumerate() {
            if date.weekday().num_days_from_monday() == sup.weekday {
                visits.push((local(date, sup.time.0, sup.time.1, 0), s));
            }
        }
        date += Duration::days(1);
    }
    visits.sort();
    let mut visit_no = [0usize; 3];
    let mut current_cost: Vec<i64> = ctx.prods.iter().map(|p| p.costs[0].1).collect();
    let mut open_alert: BTreeMap<usize, usize> = BTreeMap::new();
    for (when, s) in visits {
        visit_no[s] += 1;
        let day = crate::time::business_date(when);
        let mut planned = Vec::new();
        for (idx, p) in ctx.prods.iter().enumerate() {
            if !p.tracked || p.role != Role::Normal || p.spec.weight == 0 {
                continue;
            }
            let Some(pos) = p.suppliers.iter().position(|(sup, _)| *sup == s) else {
                continue;
            };
            let primary = pos == 0;
            let turn = visit_no[s] + idx;
            if !(if primary {
                turn % 2 == 0
            } else {
                turn % 4 == 1
            }) {
                continue;
            }
            let pack = pack_size(p.spec) as u64;
            let need = expected_daily_milli(ctx, p) * if primary { 15 } else { 7 } / 1000;
            let qty = (need.div_ceil(pack).max(1) * pack) as i32;
            let factor = p.suppliers[pos].1;
            let unit_cost = round50((p.cost_on(day) * factor + 500) / 1000);
            planned.push(PlannedLine {
                product: idx,
                qty,
                unit_cost,
            });
        }
        if planned.is_empty() {
            continue;
        }
        let k = out
            .receipts
            .iter()
            .filter(|r| r.status == "confirmed")
            .count() as u64;
        let receipt = id(T_RECEIPT, k);
        let expense = id(T_EXPENSE, 100 + k);
        let confirmed_at = when + Duration::minutes(4);
        let total: i64 = planned.iter().map(|l| i64::from(l.qty) * l.unit_cost).sum();
        let mut rng = Prng::new(&format!("{SEED}/receipt/{k}"));
        let decisions = rng.next() % 100 < 70;
        let number = format!("HD{:05}", 3000 + k * 7);
        let mut text = header(s, &number, day);
        for (pos, l) in planned.iter().enumerate() {
            let p = &ctx.prods[l.product];
            let name = ascii_upper(p.spec.name);
            let cost = i64::from(l.qty) * l.unit_cost;
            let raw = format!("{name} {} {} {}", l.qty, dotted(l.unit_cost), dotted(cost));
            text.push(format!("{} {raw}", pos + 1));
            let confidence = if decisions {
                0.90 + (rng.next() % 10) as f32 / 100.0
            } else {
                0.62 + (rng.next() % 38) as f32 / 100.0
            };
            let mut candidates = vec![(p.id, p.spec.name.to_string(), confidence)];
            if rng.next() % 100 < 12 {
                let other = &ctx.prods[(l.product + 1) % ctx.prods.len()];
                candidates.push((other.id, other.spec.name.to_string(), 0.18));
            }
            out.receipt_lines.push(ReceiptLineRow {
                id: id(T_RECEIPT_LINE, k * 100 + pos as u64),
                receipt,
                position: pos as i32,
                raw_text: raw,
                product_name: name,
                quantity: l.qty,
                cost,
                product: Some(p.id),
                confidence: Some(confidence),
                candidates,
            });
            out.purchase_lines.push(PurchaseLineRow {
                id: id(T_PURCHASE_LINE, k * 100 + pos as u64),
                expense,
                product: p.id,
                quantity: l.qty,
                unit_cost: l.unit_cost,
            });
            out.stock_in.push(StockIn {
                product: p.id,
                at: confirmed_at,
                qty: l.qty,
                receipt,
            });
            out.cost_history.push(PriceHistoryRow {
                id: Uuid::nil(),
                product: p.id,
                unit: None,
                field: "cost_price",
                old: Some(current_cost[l.product]),
                new: l.unit_cost,
                source: "purchase",
                changed_by: lead,
                changed_at: confirmed_at,
            });
            current_cost[l.product] = l.unit_cost;
            out.final_cost.insert(p.id, l.unit_cost);
            // Margin alert, as the expense handler raises or resolves it.
            let price = p.price_at(confirmed_at);
            if money::margin_below_threshold(price, l.unit_cost, threshold_bp) {
                let margin = money::margin_pct(price, l.unit_cost).unwrap_or(0.0);
                let suggested = money::suggested_price(l.unit_cost, threshold_bp);
                match open_alert.get(&l.product) {
                    Some(&a) => {
                        let alert = &mut out.alerts[a];
                        alert.cost = l.unit_cost;
                        alert.price = price;
                        alert.margin_pct = margin;
                        alert.suggested = suggested;
                        alert.expense = Some(expense);
                    }
                    None => {
                        open_alert.insert(l.product, out.alerts.len());
                        out.alerts.push(AlertRow {
                            id: id(T_ALERT, out.alerts.len() as u64),
                            product: p.id,
                            expense: Some(expense),
                            cost: l.unit_cost,
                            price,
                            margin_pct: margin,
                            suggested,
                            status: "open",
                            resolved_by: None,
                            resolved_at: None,
                            created_at: confirmed_at,
                        });
                    }
                }
            } else if let Some(a) = open_alert.remove(&l.product) {
                let alert = &mut out.alerts[a];
                alert.status = "dismissed";
                alert.resolved_by = Some(lead);
                alert.resolved_at = Some(confirmed_at);
            }
        }
        text.push(format!("TỔNG CỘNG: {}", dotted(total)));
        let image = images.alloc("expense_receipt", lead, when);
        out.receipts.push(ReceiptRow {
            id: receipt,
            member: lead,
            image,
            status: "confirmed",
            supplier: s,
            ocr_text: text.join("\n"),
            parser: if decisions { "decisions" } else { "fallback" },
            model: decisions.then_some("inception/mercury-decide:free"),
            timings: json!({"ocr": 1500 + rng.next() % 900, "parse": 30 + rng.next() % 40, "decisions": if decisions { 700 + rng.next() % 600 } else { 0 }, "total": 2500 + rng.next() % 1500}),
            total,
            expense: Some(expense),
            created_at: when,
            confirmed_at: Some(confirmed_at),
        });
        out.expenses.push(ExpenseRow {
            id: expense,
            member: lead,
            spent_at: confirmed_at,
            date: day,
            amount: total,
            category: "nhap_hang",
            // A small Saturday market top-up comes out of the cash box.
            paid_with: if s == 2 && total <= 800_000 {
                "cash_box"
            } else {
                "other"
            },
            image: Some(image),
            note: format!("Nhập hàng: {}", SUPPLIERS[s].name),
        });
    }
    draft(ctx, images, &mut out);
    out
}

/// The draft receipt: one unmatched line, one low-confidence line, injected OCR text.
fn draft(ctx: &Ctx, images: &mut Images, out: &mut SupplyOut) {
    let lead = ctx.members[0];
    let when = at(DRAFT_RECEIPT_AT);
    let day = crate::time::business_date(when);
    let k = out.receipts.len() as u64;
    let receipt = id(T_RECEIPT, k);
    let mut text = header(DRAFT_RECEIPT_SUPPLIER, "HD03250", day);
    let mut total = 0;
    for (pos, (name, qty, unit_cost, product, confidence)) in DRAFT_LINES.iter().enumerate() {
        let cost = i64::from(*qty) * unit_cost;
        total += cost;
        let raw = format!("{name} {qty} {} {}", dotted(*unit_cost), dotted(cost));
        text.push(format!("{} {raw}", pos + 1));
        let matched = product.map(|n| &ctx.prods[ctx.p(n)]);
        let mut candidates: Vec<(Uuid, String, f32)> = Vec::new();
        if let Some(p) = matched {
            candidates.push((p.id, p.spec.name.to_string(), *confidence));
        }
        let alt = match pos {
            DRAFT_LOW_CONFIDENCE_LINE => Some(DRAFT_LOW_CONFIDENCE_ALT),
            DRAFT_UNMATCHED_LINE => Some(DRAFT_UNMATCHED_ALT),
            _ => None,
        };
        if let Some((alt_name, probability)) = alt {
            let other = &ctx.prods[ctx.p(alt_name)];
            candidates.push((other.id, other.spec.name.to_string(), probability));
        }
        out.receipt_lines.push(ReceiptLineRow {
            id: id(T_RECEIPT_LINE, k * 100 + pos as u64),
            receipt,
            position: pos as i32,
            raw_text: raw,
            product_name: (*name).to_string(),
            quantity: *qty,
            cost,
            product: matched.map(|p| p.id),
            confidence: matched.map(|_| *confidence),
            candidates,
        });
    }
    text.push(DRAFT_INJECTION_LINE.to_string());
    text.push(format!("TỔNG CỘNG: {}", dotted(total)));
    let image = images.alloc("expense_receipt", lead, when);
    out.receipts.push(ReceiptRow {
        id: receipt,
        member: lead,
        image,
        status: "draft",
        supplier: DRAFT_RECEIPT_SUPPLIER,
        ocr_text: text.join("\n"),
        parser: "decisions",
        model: Some("inception/mercury-decide:free"),
        timings: json!({"ocr": 1840, "parse": 46, "decisions": 912, "total": 2960}),
        total,
        expense: None,
        created_at: when,
        confirmed_at: None,
    });
}

/// Electricity, water and other expenses, plus the Saturday market fee.
pub(super) fn fixed_expenses(ctx: &Ctx) -> Vec<ExpenseRow> {
    let mut out = Vec::new();
    for (date, time, category, paid_with, amount, note, who) in EXPENSES {
        out.push((
            ymd(date),
            time,
            category,
            paid_with,
            amount,
            note.to_string(),
            who,
        ));
    }
    let mut date = ymd((2026, 8, 29));
    while date <= ymd((2026, 10, 17)) {
        out.push((
            date,
            (12, 30),
            "khac",
            "cash_box",
            MARKET_FEE.1,
            MARKET_FEE.0.to_string(),
            MEMBER_SELLER,
        ));
        date += Duration::days(7);
    }
    out.into_iter()
        .enumerate()
        .map(
            |(n, (date, time, category, paid_with, amount, note, who))| ExpenseRow {
                id: id(T_EXPENSE, 1000 + n as u64),
                member: ctx.members[ctx.member(who)],
                spent_at: local(date, time.0, time.1, 0),
                date,
                amount,
                category,
                paid_with,
                image: None,
                note,
            },
        )
        .collect()
}
