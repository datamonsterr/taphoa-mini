# E4 sales and money: task list and test draft

Branch `epic/e4-sales-money`, migrations `03xx`, module folders `sales`, `expenses`, `alerts`,
`reports`, `day_close` (names per architecture §5.1 once E1 lands).

## Tasks (dependency, DoD)

| #   | Task                                                                                                    | Depends  | DoD                                                               |
| --- | ------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| T1  | Pure money math: total recompute, change, suggested price, margin pct, base unit cost, expected cash    | E1       | unit tests in matrix M1 green                                     |
| T2  | Authz table for E4 actions (void own/any, expense edit/delete, review, alerts, reports, close, exports) | E1 `can` | matrix M2 green                                                   |
| T3  | Sales create + get + list + void, sale_scans, review flagging, events                                   | T1,T2    | contract + integration tests green                                |
| T4  | Review queue list + resolve (link/enrolled/dismiss)                                                     | T3       | tests green                                                       |
| T5  | Expenses CRUD + purchase lines (cost raise, price_history, margin alert upsert)                         | T1,T2    | tests green                                                       |
| T6  | Alerts list/accept/dismiss (accept reuses E3 price-change path or minimal local update + price.changed) | T5       | tests green                                                       |
| T7  | Reports today/summary/top-products/recognition (single aggregate SQL each)                              | T3,T5    | tests + EXPLAIN uses store_id/business_date indexes; p95 measured |
| T8  | Day close put/get/list, late_sales_count                                                                | T3,T5    | tests green                                                       |
| T9  | Transactions export csv/xlsx                                                                            | T3,T5    | tests green                                                       |
| T10 | Redis cache for /reports/today only if measured p95 > 100 ms at seeded volume                           | T7       | measurement recorded in PR                                        |
| T11 | e2e `packages/e2e/tests/sales.test.ts` (+ money flows), CI green                                        | all      | e2e green                                                         |

## Test matrix

M1 unit (money, state): total = sum(qty*price); mismatch -> 400 total_mismatch; cash_received >= total,
cash only for payment cash, change_given = received - total; business_date at 23:59:59+07 and 00:00:00+07
(UTC day boundary); suggested price = ceil1000(cost*(1+max(threshold,10%))) (cost 8500 -> 10000 at 9% threshold);
margin_pct = (price-cost)/price; base_unit_cost = ceil(unit_cost/qty_in_base); expected_cash = open + cash_sales - cash_refunds - cash_expenses;
sale state completed->voided only, second void idempotent; manual line review open->resolved only;
alert open->open|accepted|dismissed, terminal states reject accept (409); purchase on open alert updates it (one open per product).

M2 authz: void any = Lead only; void own same day = seller; seller other's sale = 403; seller void own next day = 403;
expense edit/delete any = Lead (author may edit own per OpenAPI); review/alerts/recognition/day-close/exports = Lead only; seller 403 on each.

## Per-endpoint integration/contract cases (each: happy, authz, validation, idempotency, store isolation 404, pagination)

- POST /v1/sales: 201 then 200 replay (no second sale.created event); same id different body 409;
  sold_at price differs from price_history -> price_mismatch + review + review.line_flagged; manual line product null -> review open;
  product_id null with non-manual source 400; unknown product/scan of other store 404/400; lines 0 or >200 400; qty 0/1000 400;
  member_id from token; detection_id reused 409; response validates against openapi Sale.
- GET /v1/sales: filters from/to (business_date), member_id, payment_method, status; cursor pagination newest first; other store invisible.
- GET /v1/sales/{id}: 404 other store. POST void: reason required; replay 200 unchanged; emits sale.voided once.
- GET /v1/review/manual-lines: status filter, crop_image, Lead only. resolve: link needs product_id (400), product other store 404, already resolved 409, emits review.line_resolved; sale amounts unchanged.
- POST /v1/expenses: amount must equal line sum when lines; lines only with nhap_hang; cost_price updated, price_history source=purchase;
  margin below threshold -> alert in response `alerts` + alert.created; second purchase updates the same open alert; replay 200; conflict 409.
- PATCH/DELETE expense: Lead; purchase lines not editable (400); soft delete excluded from reports and list; cost not rolled back.
- Alerts: list status filter; accept with/without new_price (sets price, price_history source margin_alert, price.changed, alert.resolved); accept twice 409; dismiss.
- Reports: today default date Asia/Ho_Chi_Minh; voided excluded from revenue, counted in voided_count; deleted expenses excluded; summary day/week/month bucket boundaries, from>to 400; top-products sort/limit/gross_margin null without cost; recognition rates.
- Day close: put computes expected from server records; re-close overwrites; late_sales_count; negative difference; get 404 when none; list range.
- Export: csv and xlsx content type, Content-Disposition, Lead only, range validation.
- Events: every write emits matching change_log/outbox row in the same transaction (rollback leaves none).
