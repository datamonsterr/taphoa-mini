use super::*;

struct Line {
    product: usize,
    source: &'static str,
    quantity: i32,
    price: i64,
    unit: Option<Uuid>,
    size: i32,
    mismatch: bool,
}

pub(super) async fn seed(tx: &mut Tx<'_>, store: Store) -> Result<()> {
    for offset in (0..30_u64).rev() {
        let day = store.today - Duration::days(offset as i64);
        let mut rng = Prng::new(&format!("{SEED}/sales/{}/{offset}", store.number));
        let count = 15 + rng.next() % 26;
        for n in 0..count {
            let key = offset * 100 + n;
            let sale = store.id(20, key);
            // Today uses midnight..now, so even today's fixtures are not future sales.
            let day_start = store.at(day, 0, 0)?;
            let at = if offset == 0 {
                let elapsed = (store.now - day_start).num_seconds().max(0);
                day_start + Duration::seconds(elapsed * (n as i64 + 1) / (count as i64 + 1))
            } else {
                store.at(day, 7 + (n / 4) as u32, ((n % 4) * 15) as u32)?
            };
            let member = n % 4;
            let cash = n % 3 != 0;
            let voided = n == 7 || n == 19;
            let mut lines = Vec::new();
            for position in 0..(1 + rng.next() % 3) {
                let mut product = (rng.next() % PRODUCTS.len() as u64) as usize;
                let source = ["camera", "multi_photo", "barcode", "grid", "manual"]
                    [((n + position) % 5) as usize];
                if source == "barcode" && product.is_multiple_of(5) {
                    product += 1;
                }
                let size = if n % 11 == 0 && source != "manual" {
                    6
                } else {
                    1
                };
                let catalog_price = if size == 1 {
                    PRODUCTS[product].price
                } else {
                    unit_price(product, size)
                };
                let mismatch = source != "manual" && n % 13 == 0;
                lines.push(Line {
                    product,
                    source,
                    size,
                    mismatch,
                    quantity: (1 + rng.next() % 3) as i32,
                    price: if source == "manual" {
                        5000
                    } else {
                        catalog_price + if mismatch { 1000 } else { 0 }
                    },
                    unit: (size > 1).then_some(store.id(6, product as u64 * 2)),
                });
            }
            let total: i64 = lines.iter().map(|l| i64::from(l.quantity) * l.price).sum();
            // A bijection in this small range avoids probabilistic code collisions.
            let code = crockford(u128::from(key * 65_537 + store.number * 7919), 6);
            let voided_at = voided.then_some(if offset == 0 {
                at
            } else {
                store.at(day, 23, 0)?
            });
            let request = json!({"id":sale,"code":code,"sold_at":at,"business_date":day,"member_id":store.id(1,member),"payment_method":if cash {"cash"} else {"transfer"},"total":total,"lines":lines.iter().map(|l|json!({"product_id":(l.source!="manual").then_some(store.id(5,l.product as u64)),"source":l.source,"quantity":l.quantity,"unit_price":l.price,"quantity_in_base":l.size,"unit_id":l.unit})).collect::<Vec<_>>()});
            sqlx::query("INSERT INTO sales (id,store_id,code,member_id,clerk_session_id,sold_at,received_at,business_date,payment_method,cash_received,total,vietqr_memo,status,void_reason,voided_by,voided_at,request_hash) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING")
                .bind(sale).bind(store.store_id()).bind(&code).bind(store.id(1,member)).bind(None::<String>)
                .bind(at).bind(day).bind(if cash {"cash"} else {"transfer"})
                .bind(cash.then_some(((total+9999)/10000)*10000)).bind(total)
                .bind((!cash && store.number == 1).then(||format!("TH{code}")))
                .bind(if voided {"voided"} else {"completed"}).bind(voided.then_some("Khách đổi ý, đã hoàn tiền"))
                .bind(voided.then_some(store.id(1,0))).bind(voided_at).bind(digest(&request.to_string()))
                .execute(&mut **tx).await?;
            for (position, line) in lines.iter().enumerate() {
                let line_key = key * 4 + position as u64;
                let photo = matches!(line.source, "camera" | "multi_photo");
                let detection = if photo {
                    Some(scan(tx, store, line_key, line, member, at).await?)
                } else {
                    None
                };
                let manual = line.source == "manual";
                let review = manual || line.mismatch;
                let reason = if manual {
                    "manual_price"
                } else {
                    "price_mismatch"
                };
                let line_id = store.id(21, line_key);
                sqlx::query("INSERT INTO sale_lines (id,store_id,sale_id,position,product_id,unit_id,source,quantity,unit_price,quantity_in_base,manual_label,detection_id,suggested_product_id,price_mismatch,review_status,review_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING")
                    .bind(line_id).bind(store.store_id()).bind(sale).bind(position as i16)
                    .bind((!manual).then_some(store.id(5,line.product as u64))).bind(line.unit).bind(line.source)
                    .bind(line.quantity).bind(line.price).bind(line.size).bind(manual.then_some("Trứng gà lẻ"))
                    .bind(detection).bind(manual.then_some(store.id(5,line.product as u64))).bind(line.mismatch)
                    .bind(review.then_some("open")).bind(review.then_some(reason)).execute(&mut **tx).await?;
                if photo {
                    sqlx::query("INSERT INTO sale_scans (sale_id,scan_id) VALUES ($1,$2) ON CONFLICT DO NOTHING")
                        .bind(sale).bind(store.id(22,line_key)).execute(&mut **tx).await?;
                }
            }
            event(tx,store,"sale.created",json!({"sale_id":sale,"code":code,"total":total,"payment_method":if cash {"cash"} else {"transfer"},"member_id":store.id(1,member),"business_date":day,"line_count":lines.len()}),None,at).await?;
            if let Some(voided_at) = voided_at {
                event(tx,store,"sale.voided",json!({"sale_id":sale,"reason":"Khách đổi ý, đã hoàn tiền","voided_by":store.id(1,0),"total":total}),None,voided_at).await?;
            }
        }
        expense(tx, store, offset, day).await?;
        if offset > 0 {
            close(tx, store, day).await?;
        }
    }
    alerts(tx, store).await
}

async fn scan(
    tx: &mut Tx<'_>,
    store: Store,
    key: u64,
    line: &Line,
    member: u64,
    at: DateTime<Utc>,
) -> Result<Uuid> {
    let scan = store.id(22, key);
    let original = image(tx, store, 11, key, "checkout", at).await?;
    sqlx::query("INSERT INTO scans (id,store_id,image_id,member_id,mode,purpose,segmenter,embedder,catalog_version,timings,created_at) VALUES ($1,$2,$3,$4,$5,'checkout','sam-vit-b-onnx@1','dinov2-vits14-onnx@1',(SELECT max(seq) FROM change_log WHERE store_id=$2),$6,$7) ON CONFLICT DO NOTHING")
        .bind(scan).bind(store.store_id()).bind(original).bind(store.id(1,member))
        .bind(if line.source=="multi_photo" {"multi"} else {"single"})
        .bind(json!({"segment":120,"embed":25,"search":5,"total":150})).bind(at)
        .execute(&mut **tx).await?;
    for (position, matched) in ["matched", "ambiguous", "unknown"].iter().enumerate() {
        let crop = image(tx, store, 12, key * 3 + position as u64, "crop", at).await?;
        let candidates = match *matched {
            "matched" => json!([{"product_id":store.id(5,line.product as u64),"similarity":0.96}]),
            "ambiguous" => {
                json!([{"product_id":store.id(5,line.product as u64),"similarity":0.78},{"product_id":store.id(5,((line.product+1)%PRODUCTS.len()) as u64),"similarity":0.77}])
            }
            _ => json!([]),
        };
        sqlx::query("INSERT INTO detections (id,store_id,scan_id,position,bbox,score,area,crop_image_id,embedding,match,candidates) VALUES ($1,$2,$3,$4,$5,0.95,12000,$6,$7::text::vector,$8,$9) ON CONFLICT DO NOTHING")
            .bind(store.id(23,key*3+position as u64)).bind(store.store_id()).bind(scan).bind(position as i16)
            .bind(vec![10_f32+position as f32*130.,20.,100.,120.]).bind(crop)
            .bind(vector(store.id(5,line.product as u64))).bind(matched).bind(candidates)
            .execute(&mut **tx).await?;
    }
    Ok(store.id(23, key * 3))
}

async fn expense(tx: &mut Tx<'_>, store: Store, offset: u64, day: NaiveDate) -> Result<()> {
    let id = store.id(24, offset);
    let category = ["nhap_hang", "dien", "nuoc", "khac"][(offset % 4) as usize];
    let purchase = category == "nhap_hang";
    let paid_with = if purchase || offset.is_multiple_of(2) {
        "other"
    } else {
        "cash_box"
    };
    let at = if offset == 0 {
        store.at(day, 0, 0)?
    } else {
        store.at(day, 10, 30)?
    };
    let receipt = image(tx, store, 13, offset, "expense_receipt", at).await?;
    let amount = if purchase {
        PRODUCTS.iter().take(3).map(|p| p.cost).sum::<i64>() * 30 * 2
    } else {
        match category {
            "dien" => 65000,
            "nuoc" => 25000,
            _ => 15000,
        }
    };
    let note = match category {
        "nhap_hang" => "Nhập mì từ đại lý chợ Bình Tây",
        "dien" => "Tiền điện quầy và tủ mát",
        "nuoc" => "Nước sinh hoạt cửa hàng",
        _ => "Túi đựng hàng và dây thun",
    };
    let request = json!({"id":id,"spent_at":at,"business_date":day,"amount":amount,"category":category,"paid_with":paid_with,"image_id":receipt,"note":note});
    sqlx::query("INSERT INTO expenses (id,store_id,member_id,spent_at,business_date,amount,category,paid_with,image_id,note,request_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$4,$4) ON CONFLICT DO NOTHING")
        .bind(id).bind(store.store_id()).bind(store.id(1,0)).bind(at).bind(day).bind(amount).bind(category).bind(paid_with).bind(receipt).bind(note).bind(digest(&request.to_string()))
        .execute(&mut **tx).await?;
    if purchase {
        for (p, product) in PRODUCTS.iter().enumerate().take(3) {
            let size = case_size(p);
            sqlx::query("INSERT INTO purchase_lines (id,store_id,expense_id,product_id,unit_id,quantity,unit_cost,base_unit_cost) VALUES ($1,$2,$3,$4,$5,2,$6,$7) ON CONFLICT DO NOTHING")
                .bind(store.id(25,offset*3+p as u64)).bind(store.store_id()).bind(id).bind(store.id(5,p as u64))
                .bind(store.id(6,p as u64*2+1)).bind(product.cost*i64::from(size)).bind(product.cost)
                .execute(&mut **tx).await?;
        }
    }
    event(
        tx,
        store,
        "expense.created",
        json!({"expense_id":id,"amount":amount,"category":category,"business_date":day}),
        None,
        at,
    )
    .await
}

async fn close(tx: &mut Tx<'_>, store: Store, day: NaiveDate) -> Result<()> {
    // Gross cash receipts include sales later voided. Refunds remove those once;
    // transfers include completed sales only. Expenses outside the till are excluded.
    sqlx::query("WITH money AS (SELECT COALESCE(sum(total) FILTER (WHERE payment_method='cash'),0)::bigint AS cash_sales,COALESCE(sum(total) FILTER (WHERE payment_method='cash' AND status='voided'),0)::bigint AS cash_refunds,COALESCE(sum(total) FILTER (WHERE payment_method='transfer' AND status='completed'),0)::bigint AS transfer_revenue FROM sales WHERE store_id=$1 AND business_date=$2), costs AS (SELECT COALESCE(sum(amount),0)::bigint AS cash_expenses FROM expenses WHERE store_id=$1 AND business_date=$2 AND paid_with='cash_box' AND deleted_at IS NULL) INSERT INTO day_closes (store_id,business_date,opening_float,cash_sales,cash_refunds,cash_expenses,expected_cash,counted_cash,transfer_revenue,note,closed_by,closed_at) SELECT $1,$2,500000,cash_sales,cash_refunds,cash_expenses,500000+cash_sales-cash_refunds-cash_expenses,500000+cash_sales-cash_refunds-cash_expenses,transfer_revenue,'Đã kiểm quỹ; hoàn tiền sau khi ghi nhận bán hàng',$3,$4 FROM money CROSS JOIN costs ON CONFLICT DO NOTHING")
        .bind(store.store_id()).bind(day).bind(store.id(1,0)).bind(store.at(day,23,30)?)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn alerts(tx: &mut Tx<'_>, store: Store) -> Result<()> {
    for (n, status) in ["open", "accepted", "dismissed"].iter().enumerate() {
        let product = &PRODUCTS[n];
        let cost = product.cost;
        // The accepted alert records the old selling price; current catalog price
        // already reflects the accepted suggestion.
        let selling = if *status == "accepted" {
            product.price - 1000
        } else {
            product.price
        };
        let suggested = if *status == "accepted" {
            product.price
        } else {
            ((cost * 125 / 100 + 499) / 500) * 500
        };
        let resolved = *status != "open";
        let at = if *status == "accepted" {
            store.at(store.today - Duration::days(29), 6, 0)?
        } else {
            store.at(store.today - Duration::days(1), 11, 0)?
        };
        sqlx::query("INSERT INTO margin_alerts (id,store_id,product_id,expense_id,cost_price,selling_price,margin_pct,suggested_price,status,resolved_by,resolved_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,round((($6::bigint-$5::bigint)::numeric/$6::bigint)*100,2),$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING")
            .bind(store.id(26,n as u64)).bind(store.store_id()).bind(store.id(5,n as u64)).bind(if *status == "accepted" { None } else { Some(store.id(24,4)) })
            .bind(cost).bind(selling).bind(suggested).bind(status)
            .bind(resolved.then_some(store.id(1,0))).bind(resolved.then_some(at+Duration::minutes(5))).bind(at)
            .execute(&mut **tx).await?;
        if *status == "accepted" {
            sqlx::query("INSERT INTO price_history (id,store_id,product_id,field,old_value,new_value,source,changed_by,changed_at) VALUES ($1,$2,$3,'price',$4,$5,'margin_alert',$6,$7) ON CONFLICT DO NOTHING")
                .bind(store.id(8,100)).bind(store.store_id()).bind(store.id(5,n as u64)).bind(selling).bind(suggested)
                .bind(store.id(1,0)).bind(at+Duration::minutes(5)).execute(&mut **tx).await?;
        }
    }
    Ok(())
}
