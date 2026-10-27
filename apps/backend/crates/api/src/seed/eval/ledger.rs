//! The stock ledger of every tracked product: an opening count, then receipts, sales and voids in
//! time order, then the scripted stock-takes that leave the documented low, out and negative
//! states. Final stock is always the sum of the deltas, like in the real service.
use super::build::*;
use super::catalog::*;
use super::model::*;
use super::{sales::SalesOut, supply::SupplyOut};
use crate::seed::Prng;
use chrono::{DateTime, Duration, Utc};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) struct LedgerOut {
    pub movements: Vec<MovementRow>,
    /// Final stock by product id; untracked products are absent.
    pub stock: BTreeMap<Uuid, i32>,
}

enum Ev {
    Delta(i32),
    SetTo(i32),
}

struct Event {
    at: DateTime<Utc>,
    ev: Ev,
    reason: &'static str,
    ref_id: Option<Uuid>,
    member: Uuid,
    note: Option<&'static str>,
}

pub(super) fn build(ctx: &Ctx, sales: &SalesOut, supply: &SupplyOut) -> LedgerOut {
    let lead = ctx.members[0];
    let index: BTreeMap<Uuid, usize> = ctx
        .prods
        .iter()
        .enumerate()
        .map(|(i, p)| (p.id, i))
        .collect();
    let sale_of: BTreeMap<Uuid, &SaleRow> = sales.sales.iter().map(|s| (s.id, s)).collect();
    let mut events: Vec<Vec<Event>> = ctx.prods.iter().map(|_| Vec::new()).collect();
    for line in &sales.lines {
        let Some(product) = line.product else {
            continue;
        };
        let i = index[&product];
        if !ctx.prods[i].tracked {
            continue;
        }
        let sale = sale_of[&line.sale];
        let base = line.quantity * line.quantity_in_base;
        events[i].push(Event {
            at: sale.sold_at,
            ev: Ev::Delta(-base),
            reason: "sale",
            ref_id: Some(sale.id),
            member: sale.member,
            note: None,
        });
        if let Some(void) = &sale.void {
            events[i].push(Event {
                at: void.at,
                ev: Ev::Delta(base),
                reason: "sale_void",
                ref_id: Some(sale.id),
                member: void.by,
                note: None,
            });
        }
    }
    for r in &supply.stock_in {
        events[index[&r.product]].push(Event {
            at: r.at,
            ev: Ev::Delta(r.qty),
            reason: "receipt",
            ref_id: Some(r.receipt),
            member: lead,
            note: None,
        });
    }
    for (name, count, _) in NEGATIVE_STOCK {
        events[ctx.p(name)].push(Event {
            at: at(NEGATIVE_STOCK_COUNT_AT),
            ev: Ev::SetTo(count),
            reason: "adjustment",
            ref_id: None,
            member: lead,
            note: Some("Kiểm kho kệ hàng"),
        });
    }

    let first_at = local(ctx.first, 6, 0, 0);
    let mut rows: Vec<(usize, usize, MovementRow)> = Vec::new();
    let mut stock = BTreeMap::new();
    for (i, p) in ctx.prods.iter().enumerate() {
        if !p.tracked {
            continue;
        }
        let mut evs = std::mem::take(&mut events[i]);
        // Stable sort: events of the same instant keep their generation order.
        evs.sort_by_key(|e| e.at);
        let threshold = p.threshold();
        let name = p.spec.name;
        let target = LOW_STOCK
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, t)| *t)
            .or_else(|| OUT_OF_STOCK.contains(&name).then_some(0));
        let scripted_negative = NEGATIVE_STOCK.iter().any(|(n, ..)| *n == name);
        let (mut running, mut min_prefix, mut total, mut has_set) = (0, 0, 0, false);
        for e in &evs {
            match e.ev {
                Ev::Delta(d) => {
                    if !has_set {
                        running += d;
                        min_prefix = min_prefix.min(running);
                    }
                    total += d;
                }
                Ev::SetTo(_) => has_set = true,
            }
        }
        let mut rng = Prng::new(&format!("{SEED}/opening/{name}"));
        let jitter = rng.next();
        let base_open = if p.role == Role::Normal {
            (super::supply::expected_daily_milli(ctx, p) * (7 + jitter % 6) / 1000) as i32
                + threshold.max(5)
                + 4
        } else {
            14 + (jitter % 12) as i32
        };
        let mut opening = base_open.max(-min_prefix);
        if target.is_none() && !scripted_negative {
            // Healthy by construction: above the threshold, so only the fixtures are low.
            let guard = (threshold + 3).max(5);
            opening = opening.max(guard - total);
        }
        let mut seq = 0;
        let mut push = |rows: &mut Vec<(usize, usize, MovementRow)>, row: MovementRow| {
            rows.push((i, seq, row));
            seq += 1;
        };
        let movement =
            |at: DateTime<Utc>, delta: i32, after: i32, reason, ref_id, member, note| MovementRow {
                id: Uuid::nil(),
                product: p.id,
                delta,
                after,
                reason,
                ref_id,
                member,
                note,
                at,
            };
        push(
            &mut rows,
            movement(
                first_at,
                opening,
                opening,
                "adjustment",
                None,
                lead,
                Some("Kiểm kho ban đầu"),
            ),
        );
        let mut running = opening;
        let mut last_at = first_at;
        for e in &evs {
            let delta = match e.ev {
                Ev::Delta(d) => d,
                Ev::SetTo(c) => c - running,
            };
            running += delta;
            last_at = e.at;
            push(
                &mut rows,
                movement(e.at, delta, running, e.reason, e.ref_id, e.member, e.note),
            );
        }
        if let Some(target) = target
            && running != target
        {
            let when = last_at + Duration::minutes(2);
            assert!(when <= ctx.now, "stock-take of {name} after 17:00");
            let delta = target - running;
            running = target;
            push(
                &mut rows,
                movement(
                    when,
                    delta,
                    running,
                    "adjustment",
                    None,
                    lead,
                    Some("Kiểm kho cuối ngày"),
                ),
            );
        }
        stock.insert(p.id, running);
    }
    rows.sort_by_key(|(product, seq, row)| (row.at, *product, *seq));
    let movements = rows
        .into_iter()
        .enumerate()
        .map(|(n, (_, _, mut row))| {
            row.id = id(T_MOVEMENT, n as u64);
            row
        })
        .collect();
    LedgerOut { movements, stock }
}
