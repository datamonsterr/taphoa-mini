//! 60 days of sales: weekday patterns, three spikes, mixed capture sources, recognition misses and
//! confusions, manual lines, price mismatches, voids and a few sales outside opening hours.
use super::build::*;
use super::catalog::*;
use super::model::*;
use crate::seed::{Prng, crockford};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};

pub(super) struct SalesOut {
    pub sales: Vec<SaleRow>,
    pub lines: Vec<SaleLineRow>,
    pub scans: Vec<ScanRow>,
    pub detections: Vec<DetectionRow>,
}

#[derive(Clone)]
enum Recog {
    Matched,
    /// `first` is the system's top suggestion; the sold product is `first` or `second`.
    Ambiguous {
        first: usize,
        second: usize,
    },
    Unknown,
}

#[derive(Clone)]
struct DLine {
    product: Option<usize>,
    unit: Option<usize>,
    /// "photo" is resolved to camera or multi_photo once the whole sale is known.
    source: &'static str,
    qty: i32,
    price: i64,
    qib: i32,
    label: Option<&'static str>,
    intended: Option<usize>,
    mismatch: bool,
    open: bool,
    resolution: Option<&'static str>,
    recog: Option<Recog>,
}

struct Draft {
    at: DateTime<Utc>,
    date: NaiveDate,
    member: usize,
    cash: bool,
    lines: Vec<DLine>,
    scripted: bool,
    /// Never voided (their lines are the documented last sales of fixture products).
    protected: bool,
    void: Option<(DateTime<Utc>, &'static str)>,
    order: usize,
}

fn pick(rng: &mut Prng, n: usize) -> usize {
    (rng.next() % n as u64) as usize
}

fn weighted(rng: &mut Prng, weights: &[u64]) -> Option<usize> {
    let total: u64 = weights.iter().sum();
    if total == 0 {
        return None;
    }
    let mut r = rng.next() % total;
    for (i, w) in weights.iter().enumerate() {
        if r < *w {
            return Some(i);
        }
        r -= w;
    }
    None
}

/// Time-of-day blocks in minutes since midnight with their share of the day's sales.
const BLOCKS: [(u32, u32, u64); 6] = [
    (390, 510, 22),
    (510, 660, 14),
    (660, 840, 14),
    (840, 1020, 16),
    (1020, 1170, 24),
    (1170, 1290, 10),
];
/// 16:50, so that the pinned "now" of 17:00 is never reached.
const LAST_DAY_CUTOFF: u32 = 1010;

fn block_masses(cutoff: Option<u32>) -> [u64; 6] {
    BLOCKS.map(|(s, e, w)| {
        let end = cutoff.map_or(e, |c| e.min(c));
        if end <= s {
            0
        } else {
            w * 1000 * u64::from(end - s) / u64::from(e - s)
        }
    })
}

fn sample_minute(rng: &mut Prng, masses: &[u64; 6], cutoff: Option<u32>) -> (u32, u32) {
    let block = weighted(rng, masses).expect("some opening time remains");
    let (start, end, _) = BLOCKS[block];
    let end = cutoff.map_or(end, |c| end.min(c));
    let minute = start + (rng.next() % u64::from(end - start)) as u32;
    (minute, (rng.next() % 60) as u32)
}

fn pick_member(rng: &mut Prng, weekday: usize, minute: u32) -> usize {
    let r = rng.next() % 100;
    if weekday < 5 && minute < 840 {
        usize::from(r >= 45)
    } else if r < 25 {
        0
    } else if r < 65 {
        1
    } else {
        2
    }
}

fn category_boost(cat: Option<usize>, weekday: usize) -> u64 {
    match cat {
        Some(2) => [800, 800, 800, 800, 1400, 1800, 1600][weekday],
        Some(3) if weekday < 5 => 1100,
        Some(3) => 900,
        Some(4) if weekday >= 5 => 1300,
        _ => 1000,
    }
}

fn spike_boost(cat: Option<usize>, date: NaiveDate) -> u64 {
    match ((date.year(), date.month(), date.day()), cat) {
        ((2026, 9, 2), Some(2)) => 2200,
        ((2026, 9, 2), Some(1)) => 1800,
        ((2026, 9, 2), Some(4)) => 1500,
        ((2026, 9, 25), Some(4)) => 3000,
        ((2026, 9, 25), Some(1)) => 1600,
        ((2026, 9, 25), Some(3)) => 1300,
        ((2026, 10, 20), Some(4)) | ((2026, 10, 20), Some(8)) => 2000,
        ((2026, 10, 20), Some(3)) => 1300,
        _ => 1000,
    }
}

fn day_weights(ctx: &Ctx, date: NaiveDate) -> Vec<u64> {
    let weekday = date.weekday().num_days_from_monday() as usize;
    ctx.prods
        .iter()
        .map(|p| {
            let base = match p.role {
                Role::Never => 0,
                Role::Seasonal => {
                    let (from, to) = (ymd(SEASONAL_WINDOW.0), ymd(SEASONAL_WINDOW.1));
                    if date >= from && date <= to {
                        2000 + 400 * (date - from).num_days() as u64
                    } else {
                        0
                    }
                }
                _ => u64::from(p.spec.weight) * 1000,
            };
            if base == 0 || p.last_active.is_some_and(|d| date > d) {
                return 0;
            }
            base * category_boost(p.spec.cat, weekday) / 1000 * spike_boost(p.spec.cat, date) / 1000
        })
        .collect()
}

fn pick_qty(rng: &mut Prng, spec: &Spec) -> i32 {
    let (values, weights): (&[i32], &[u64]) = if spec.price >= 40_000 {
        (&[1, 2, 3], &[80, 15, 5])
    } else if spec.cat == Some(BEER_CATEGORY) {
        (&[1, 2, 3, 4, 6, 12], &[28, 22, 14, 10, 18, 8])
    } else if EGG_PRODUCTS.contains(&spec.name) {
        (&[1, 2, 3, 4, 6, 10], &[20, 25, 15, 10, 20, 10])
    } else {
        (&[1, 2, 3, 4, 6], &[60, 25, 9, 4, 2])
    };
    values[weighted(rng, weights).expect("weights")]
}

fn recognition(ctx: &Ctx, rng: &mut Prng, actual: usize) -> Recog {
    let name = ctx.prods[actual].spec.name;
    let unknown = if RECOGNITION_MISSES.contains(&name) {
        45
    } else {
        4
    };
    if rng.next() % 100 < unknown {
        return Recog::Unknown;
    }
    if let Some((suggested, _, pct)) = RECOGNITION_CONFUSIONS.iter().find(|c| c.1 == name)
        && rng.next() % 100 < *pct
    {
        return Recog::Ambiguous {
            first: ctx.p(suggested),
            second: actual,
        };
    }
    let cat = ctx.prods[actual].spec.cat;
    let others: Vec<usize> = (0..ctx.prods.len())
        .filter(|&i| i != actual && ctx.prods[i].spec.cat == cat)
        .collect();
    if rng.next() % 100 < 10 && !others.is_empty() {
        let other = others[pick(rng, others.len())];
        return if rng.next() % 100 < 70 {
            Recog::Ambiguous {
                first: actual,
                second: other,
            }
        } else {
            Recog::Ambiguous {
                first: other,
                second: actual,
            }
        };
    }
    Recog::Matched
}

fn random_lines(
    ctx: &Ctx,
    rng: &mut Prng,
    date: NaiveDate,
    at: DateTime<Utc>,
    weights: &[u64],
) -> Vec<DLine> {
    let wanted = 1 + weighted(rng, &[45, 30, 15, 7, 3]).expect("weights");
    let mut chosen: Vec<usize> = Vec::new();
    for _ in 0..wanted {
        let mut w = weights.to_vec();
        for &c in &chosen {
            w[c] = 0;
        }
        for (i, p) in ctx.prods.iter().enumerate() {
            if p.frozen_from.is_some_and(|f| at >= f) {
                w[i] = 0;
            }
        }
        match weighted(rng, &w) {
            Some(i) => chosen.push(i),
            None => break,
        }
    }
    let old_period = date < ymd(OPEN_ISSUES_FROM);
    let mut lines = Vec::new();
    for &i in &chosen {
        let p = &ctx.prods[i];
        if old_period && rng.next() % 1000 < 12 {
            let (label, likely) = MANUAL_POOL[pick(rng, MANUAL_POOL.len())];
            let intended = likely.map(|n| ctx.p(n));
            let price = intended.map_or(5000 + 5000 * (rng.next() % 3) as i64, |k| {
                ctx.prods[k].price_at(at)
            });
            let resolution = match (intended, rng.next() % 100) {
                (Some(_), r) if r < 65 => "link",
                (Some(_), r) if r < 80 => "enrolled",
                _ => "dismiss",
            };
            lines.push(DLine {
                product: None,
                unit: None,
                source: "manual",
                qty: 1 + (rng.next() % 3) as i32,
                price,
                qib: 1,
                label: Some(label),
                intended,
                mismatch: false,
                open: false,
                resolution: Some(resolution),
                recog: None,
            });
            continue;
        }
        let with_unit = !p.units.is_empty() && rng.next() % 100 < 6;
        let (unit, qty, mut price, qib) = if with_unit {
            // Mostly the smaller package (a six-pack), rarely the crate.
            let u = if rng.next() % 100 < 85 {
                0
            } else {
                pick(rng, p.units.len())
            };
            let qty = 1 + i32::from(rng.next().is_multiple_of(10));
            (Some(u), qty, p.units[u].price, p.units[u].qib)
        } else {
            (None, pick_qty(rng, p.spec), p.price_at(at), 1)
        };
        let mut mismatch = false;
        if old_period && unit.is_none() && price >= 3000 && rng.next() % 1000 < 15 {
            price -= [500, 1000, 1500][pick(rng, 3)];
            mismatch = true;
        }
        lines.push(DLine {
            product: Some(i),
            unit,
            source: "grid",
            qty,
            price,
            qib,
            label: None,
            intended: None,
            mismatch,
            open: false,
            resolution: mismatch.then_some("dismiss"),
            recog: None,
        });
    }
    // Capture source: barcode, photo or grid. Several photo lines share one scan ("multi").
    for l in lines.iter_mut().filter(|l| l.product.is_some()) {
        let has_barcode = ctx.prods[l.product.expect("product")].spec.barcode;
        let r = rng.next() % 100;
        l.source = if has_barcode && r < 30 {
            "barcode"
        } else if r < if has_barcode { 75 } else { 55 } {
            "photo"
        } else {
            "grid"
        };
    }
    let photos = lines.iter().filter(|l| l.source == "photo").count();
    for l in lines.iter_mut().filter(|l| l.source == "photo") {
        l.source = if photos > 1 { "multi_photo" } else { "camera" };
        l.recog = Some(recognition(ctx, rng, l.product.expect("product")));
    }
    lines
}

fn random_day(ctx: &Ctx, date: NaiveDate, drafts: &mut Vec<Draft>) {
    let mut rng = Prng::new(&format!("{SEED}/day/{date}"));
    let weekday = date.weekday().num_days_from_monday() as usize;
    let cutoff = (date == ctx.today).then_some(LAST_DAY_CUTOFF);
    let masses = block_masses(cutoff);
    let share = masses.iter().sum::<u64>() / 100;
    let base = [26u64, 26, 27, 27, 30, 35, 34][weekday];
    let spike = SPIKES
        .iter()
        .find(|s| ymd(s.0) == date)
        .map_or(1000, |s| s.2);
    let jitter = 880 + rng.next() % 241;
    let count = (base * spike * jitter * share + 500_000_000) / 1_000_000_000;
    let weights = day_weights(ctx, date);
    for _ in 0..count {
        let (minute, second) = sample_minute(&mut rng, &masses, cutoff);
        let at = local(date, minute / 60, minute % 60, second);
        let member = pick_member(&mut rng, weekday, minute);
        let cash = rng.next() % 100 < 65;
        let lines = random_lines(ctx, &mut rng, date, at, &weights);
        let order = drafts.len();
        drafts.push(Draft {
            at,
            date,
            member,
            cash,
            lines,
            scripted: false,
            protected: false,
            void: None,
            order,
        });
    }
}

fn item(ctx: &Ctx, name: &str, qty: i32, price: Option<i64>, when: DateTime<Utc>) -> DLine {
    let i = ctx.p(name);
    let p = &ctx.prods[i];
    let list = p.price_at(when);
    let charged = price.unwrap_or(list);
    DLine {
        product: Some(i),
        unit: None,
        source: if p.spec.barcode { "barcode" } else { "grid" },
        qty,
        price: charged,
        qib: 1,
        label: None,
        intended: None,
        mismatch: charged != list,
        open: false,
        resolution: (charged != list).then_some("dismiss"),
        recog: None,
    }
}

fn scripted(ctx: &Ctx, drafts: &mut Vec<Draft>) {
    let mut add = |when: DateTime<Utc>, member: usize, cash: bool, lines: Vec<DLine>| {
        let order = drafts.len();
        drafts.push(Draft {
            at: when,
            date: crate::time::business_date(when),
            member,
            cash,
            lines,
            scripted: true,
            protected: true,
            void: None,
            order,
        });
    };
    // The last sale of each dead-stock and slow-moving fixture.
    for (k, (name, date)) in DEAD_STOCK.iter().chain(SLOW_MOVERS.iter()).enumerate() {
        let when = local(ymd(*date), 10, 20 + 7 * (k as u32 % 6), 0);
        add(when, k % 2, true, vec![item(ctx, name, 1, None, when)]);
    }
    for m in &MANUAL_OPEN {
        let when = at(m.at);
        let likely = ctx.p(m.likely);
        add(
            when,
            ctx.member(m.member),
            true,
            vec![DLine {
                product: None,
                unit: None,
                source: "manual",
                qty: m.quantity,
                price: m.price,
                qib: 1,
                label: Some(m.label),
                intended: Some(likely),
                mismatch: false,
                open: true,
                resolution: None,
                recog: None,
            }],
        );
    }
    for (name, when, price, qty, who) in PRICE_MISMATCH_OPEN {
        let when = at(when);
        let mut line = item(ctx, name, qty, Some(price), when);
        line.open = true;
        line.resolution = None;
        add(when, ctx.member(who), true, vec![line]);
    }
    for o in &OUT_OF_HOURS {
        let when = at(o.at);
        add(
            when,
            ctx.member(o.member),
            true,
            vec![item(ctx, o.product, o.quantity, None, when)],
        );
    }
    for (k, (name, _count, sold)) in NEGATIVE_STOCK.iter().enumerate() {
        let when = at(NEGATIVE_STOCK_SALE_AT[k]);
        add(when, 1, true, vec![item(ctx, name, *sold, None, when)]);
    }
}

/// Every tracked product that keeps selling has a sale after 2026-09-26, so the set of dead
/// products for a 30-day window is exactly the documented one.
fn ensure_recent(ctx: &Ctx, drafts: &mut [Draft]) {
    let mut rng = Prng::new(&format!("{SEED}/ensure"));
    let (from, to) = (ymd((2026, 9, 26)), ymd((2026, 10, 18)));
    for (i, p) in ctx.prods.iter().enumerate() {
        if !(p.tracked && p.role == Role::Normal && p.spec.weight > 0) {
            continue;
        }
        if drafts
            .iter()
            .any(|d| d.date >= from && d.lines.iter().any(|l| l.product == Some(i)))
        {
            continue;
        }
        let candidates: Vec<usize> = (0..drafts.len())
            .filter(|&k| {
                let d = &drafts[k];
                !d.scripted && d.date >= from && d.date <= to
            })
            .collect();
        let k = candidates[pick(&mut rng, candidates.len())];
        let when = drafts[k].at;
        let line = item(ctx, p.spec.name, 1, None, when);
        drafts[k].lines.push(line);
        drafts[k].protected = true;
    }
    // Fast sellers sell on each of the last three days, so questions about "hôm qua" and
    // "hôm nay" have an answer for them.
    for day in [ymd((2026, 10, 18)), ymd((2026, 10, 19)), ctx.today] {
        for (i, p) in ctx.prods.iter().enumerate() {
            if !(p.role == Role::Normal && p.spec.weight >= 6) {
                continue;
            }
            let sells = |d: &Draft| d.lines.iter().any(|l| l.product == Some(i));
            if drafts.iter().any(|d| d.date == day && sells(d)) {
                continue;
            }
            let candidates: Vec<usize> = (0..drafts.len())
                .filter(|&k| !drafts[k].scripted && drafts[k].date == day)
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let k = candidates[pick(&mut rng, candidates.len())];
            let line = item(ctx, p.spec.name, 1, None, drafts[k].at);
            drafts[k].lines.push(line);
            drafts[k].protected = true;
        }
    }
}

fn mark_void(d: &mut Draft, rng: &mut Prng) {
    let reason = VOID_REASONS[pick(rng, VOID_REASONS.len())];
    let wanted = d.at + Duration::minutes(4 + (rng.next() % 40) as i64);
    // Before the day close at 21:45.
    d.void = Some((wanted.min(local(d.date, 21, 40, 0)), reason));
}

fn assign_voids(ctx: &Ctx, drafts: &mut [Draft]) {
    let mut rng = Prng::new(&format!("{SEED}/voids"));
    let heavy = ctx.member(VOID_HEAVY_MEMBER);
    let eligible = |d: &Draft| {
        !d.protected
            && !d.scripted
            && d.void.is_none()
            // The last two days stay untouched: the negative-stock fixtures are scripted there.
            && d.date < ymd(NEGATIVE_STOCK_COUNT_AT.0)
            && d.at < local(d.date, 21, 0, 0)
    };
    // Cash refunds on the day of the cash difference, all by the void-heavy member.
    let diff_day = ymd(CASH_DIFFERENCE.0);
    let mut forced: Vec<usize> = (0..drafts.len())
        .filter(|&i| eligible(&drafts[i]) && drafts[i].date == diff_day && drafts[i].cash)
        .collect();
    for _ in 0..2 {
        let k = forced.swap_remove(pick(&mut rng, forced.len()));
        drafts[k].member = heavy;
        mark_void(&mut drafts[k], &mut rng);
    }
    for (name, quota) in VOIDS {
        let member = ctx.member(name);
        let have = drafts
            .iter()
            .filter(|d| d.void.is_some() && d.member == member)
            .count();
        let mut need = quota - have;
        if member == heavy {
            let mut cash: Vec<usize> = (0..drafts.len())
                .filter(|&i| eligible(&drafts[i]) && drafts[i].member == member && drafts[i].cash)
                .collect();
            for _ in 0..(need * 80).div_ceil(100) {
                let k = cash.swap_remove(pick(&mut rng, cash.len()));
                mark_void(&mut drafts[k], &mut rng);
                need -= 1;
            }
        }
        let mut rest: Vec<usize> = (0..drafts.len())
            .filter(|&i| eligible(&drafts[i]) && drafts[i].member == member)
            .collect();
        for _ in 0..need {
            let k = rest.swap_remove(pick(&mut rng, rest.len()));
            mark_void(&mut drafts[k], &mut rng);
        }
    }
}

pub(super) fn generate(ctx: &Ctx, images: &mut Images) -> SalesOut {
    let mut drafts: Vec<Draft> = Vec::new();
    let mut date = ctx.first;
    while date <= ctx.today {
        random_day(ctx, date, &mut drafts);
        date += Duration::days(1);
    }
    scripted(ctx, &mut drafts);
    drafts.sort_by_key(|d| (d.at, d.order));
    ensure_recent(ctx, &mut drafts);
    assign_voids(ctx, &mut drafts);
    finalize(ctx, &drafts, images)
}

fn finalize(ctx: &Ctx, drafts: &[Draft], images: &mut Images) -> SalesOut {
    let mut out = SalesOut {
        sales: Vec::new(),
        lines: Vec::new(),
        scans: Vec::new(),
        detections: Vec::new(),
    };
    let lead = ctx.members[0];
    let mut detection_counter = 0u64;
    for (si, d) in drafts.iter().enumerate() {
        let sale = id(T_SALE, si as u64);
        let member = ctx.members[d.member];
        let code = crockford((si as u128 * 65_537 + 104_729) % (1 << 30), 6);
        let total: i64 = d.lines.iter().map(|l| i64::from(l.qty) * l.price).sum();
        out.sales.push(SaleRow {
            id: sale,
            memo: (!d.cash).then(|| format!("TH{code}")),
            code,
            member,
            sold_at: d.at,
            date: d.date,
            cash: d.cash,
            cash_received: d.cash.then(|| ((total + 9_999) / 10_000) * 10_000),
            total,
            void: d.void.map(|(at, reason)| VoidRow {
                reason,
                by: member,
                at,
            }),
        });
        let photo_lines = d.lines.iter().filter(|l| l.recog.is_some()).count();
        let scan = (photo_lines > 0).then(|| {
            let image = images.alloc("checkout", member, d.at);
            let scan = id(T_SCAN, si as u64);
            out.scans.push(ScanRow {
                id: scan,
                image,
                member,
                sale,
                multi: photo_lines > 1,
                created_at: d.at,
            });
            scan
        });
        let mut position = 0i16;
        for (li, l) in d.lines.iter().enumerate() {
            let mut detection = None;
            let mut suggested = None;
            if let (Some(recog), Some(scan)) = (&l.recog, scan) {
                let did = id(T_DETECTION, detection_counter);
                detection_counter += 1;
                let actual = l.product.expect("photo lines have products");
                let pid = |k: usize| ctx.prods[k].id;
                let (matched, candidates) = match recog {
                    Recog::Matched => {
                        suggested = Some(pid(actual));
                        ("matched", vec![(pid(actual), 0.95)])
                    }
                    Recog::Ambiguous { first, second } => {
                        suggested = Some(pid(*first));
                        let sims = if *first == actual {
                            (0.79, 0.76)
                        } else {
                            (0.81, 0.79)
                        };
                        (
                            "ambiguous",
                            vec![(pid(*first), sims.0), (pid(*second), sims.1)],
                        )
                    }
                    Recog::Unknown => ("unknown", Vec::new()),
                };
                out.detections.push(DetectionRow {
                    id: did,
                    scan,
                    position,
                    matched,
                    candidates,
                });
                position += 1;
                detection = Some(did);
            }
            let review = if l.product.is_none() || l.mismatch {
                let reason = if l.product.is_none() {
                    "manual_price"
                } else {
                    "price_mismatch"
                };
                Some(if l.open {
                    ReviewRow {
                        status: "open",
                        reason,
                        action: None,
                        product: None,
                        by: None,
                        at: None,
                    }
                } else {
                    let action = l.resolution.unwrap_or("dismiss");
                    ReviewRow {
                        status: "resolved",
                        reason,
                        action: Some(action),
                        product: (action != "dismiss")
                            .then(|| l.intended.map(|k| ctx.prods[k].id))
                            .flatten(),
                        by: Some(lead),
                        at: Some(local(d.date + Duration::days(1), 21, 50, 0).min(ctx.now)),
                    }
                })
            } else {
                None
            };
            out.lines.push(SaleLineRow {
                id: id(T_SALE_LINE, si as u64 * 32 + li as u64),
                sale,
                position: li as i16,
                product: l.product.map(|k| ctx.prods[k].id),
                unit: l
                    .unit
                    .map(|u| ctx.prods[l.product.expect("unit lines have products")].units[u].id),
                source: l.source,
                quantity: l.qty,
                unit_price: l.price,
                quantity_in_base: l.qib,
                label: l.label,
                detection,
                suggested,
                mismatch: l.mismatch,
                review,
            });
        }
    }
    out
}
