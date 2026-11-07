#!/usr/bin/env python3
"""Export confirmed recognition examples from a store's private data."""
import argparse
import collections
import json
import os
import pathlib
import sys
import uuid


def select_recognition(references, queries, minimum, maximum):
    """Keep entire query scans out of the reference set, then select eligible products."""
    scan_images = {q['scan_image_id'] for q in queries}
    refs = collections.defaultdict(list)
    qs = collections.defaultdict(list)
    for ref in references:
        if ref['image_id'] not in scan_images and not scan_images.intersection(ref.get('source_scan_images', [])):
            refs[ref['product_id']].append(ref)
    for query in queries:
        qs[query['product_id']].append(query)
    selected_refs, selected_queries = [], []
    for product in sorted(qs):
        chosen = qs[product][:maximum]
        if len(chosen) >= minimum and refs[product]:
            selected_refs.extend(refs[product])
            selected_queries.extend(chosen)
    return selected_refs, selected_queries


def recognition(args):
    import boto3
    import psycopg
    from botocore.config import Config
    from psycopg.rows import dict_row

    store = str(uuid.UUID(args.store))
    allowed = [str(uuid.UUID(x)) for x in args.products.split(',')] if args.products else None
    if args.min_per_product < 1 or args.max_per_product < args.min_per_product:
        raise ValueError('invalid per-product limits')
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as db:
        db.execute('SET TRANSACTION READ ONLY')
        refs = db.execute('''SELECT p.id::text product_id, i.id::text image_id,
            i.object_key key, pi.bbox, ARRAY(SELECT DISTINCT source.image_id::text FROM detections d JOIN scans source ON source.id=d.scan_id AND source.store_id=d.store_id WHERE d.store_id=p.store_id AND d.crop_image_id=i.id) source_scan_images FROM products p
            JOIN product_images pi ON pi.product_id=p.id
            JOIN images i ON i.id=pi.image_id AND i.store_id=p.store_id
            WHERE p.store_id=%s AND (%s::uuid[] IS NULL OR p.id=ANY(%s::uuid[]))
            ORDER BY p.id, pi.position, i.id''', (store, allowed, allowed)).fetchall()
        queries = db.execute('''SELECT sl.product_id::text product_id, d.id::text id,
            s.id::text scan_id, s.image_id::text scan_image_id, i.object_key key,
            CASE WHEN d.crop_image_id IS NULL THEN d.bbox ELSE NULL END bbox
            FROM sale_lines sl JOIN sales sale ON sale.id=sl.sale_id AND sale.store_id=sl.store_id
            JOIN detections d ON d.id=sl.detection_id AND d.store_id=sl.store_id
            JOIN scans s ON s.id=d.scan_id AND s.store_id=sl.store_id
            JOIN images i ON i.id=COALESCE(d.crop_image_id,s.image_id) AND i.store_id=sl.store_id
            JOIN products p ON p.id=sl.product_id AND p.store_id=sl.store_id
            WHERE sl.store_id=%s AND sale.status='completed' AND s.purpose='checkout'
              AND (%s::date IS NULL OR sale.business_date >= %s::date)
              AND (%s::date IS NULL OR sale.business_date <= %s::date)
              AND (%s::uuid[] IS NULL OR sl.product_id=ANY(%s::uuid[]))
            ORDER BY sl.product_id, sale.sold_at, d.id''',
            (store, args.start, args.start, args.end, args.end, allowed, allowed)).fetchall()
    refs, queries = select_recognition(refs, queries, args.min_per_product, args.max_per_product)
    s3 = boto3.client('s3', endpoint_url=os.environ['AWS_ENDPOINT_URL'],
        region_name=os.environ['AWS_DEFAULT_REGION'],
        config=Config(s3={'addressing_style': 'path' if os.getenv('S3_FORCE_PATH_STYLE', '').lower() == 'true' else 'virtual'}))
    root = pathlib.Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    manifest = {'references': [], 'queries': []}
    for category, rows in [('references', refs), ('queries', queries)]:
        for row in rows:
            rel = pathlib.Path('enroll', row['product_id'], row['image_id'] + '.jpg') if category == 'references' else pathlib.Path('checkout', row['id'] + '.jpg')
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(os.environ['AWS_S3_BUCKET_NAME'], row['key'], str(target))
            sample = {'product_id': row['product_id'], 'image': rel.as_posix()}
            if row['bbox'] is not None:
                sample['bbox'] = list(row['bbox'])
            manifest[category].append(sample)
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    counts = collections.Counter(row['product_id'] for row in queries)
    for product, count in sorted(counts.items()):
        print(f'{product}: {count} queries, {sum(r["product_id"] == product for r in refs)} references')
    print(f'Products: {len(counts)}; queries: {len(queries)}; distinct scans: {len({q["scan_id"] for q in queries})}')
    print(f'A1 50 products and 200 distinct scans: {"met" if len(counts) >= 50 and len({q["scan_id"] for q in queries}) >= 200 else "not met"}')


def voice_case(row):
    draft = row['draft']
    corrections = {str(c['line_id']): c for c in (row['corrections'] or [])}
    lines = []
    for line in draft['lines']:
        correction = corrections.get(str(line['id']), {})
        if correction.get('removed'):
            continue
        product = line.get('product') or {}
        chosen = correction.get('chosen_product_id')
        product_id = str(chosen or product.get('id') or '')
        name = row['product_names'].get(product_id) if chosen else product.get('name')
        price = line.get('unit_price') if line.get('price_source') == 'spoken' else None
        if correction.get('unit_price') is not None:
            price = correction['unit_price']
        lines.append({'spoken': line['spoken'], 'product': name,
                      **({'product_id': product_id} if product_id and name else {}),
                      'quantity': correction.get('quantity') or line['quantity'], 'unit_price': price})
    case = {'id': str(row['id']), 'source': 'recorded', 'review_status': 'unreviewed',
            'transcript': row['transcript'], 'language': row['language'], 'intent': 'sale',
            'payment_method': draft.get('payment_method', 'cash'), 'lines': lines,
            'original_draft': draft, 'confirmed_sale_lines': row.get('confirmed_sale_lines'),
            'tags': ['donated', 'needs-review']}
    if case['payment_method'] == 'credit':
        case['customer_name'] = (draft.get('customer') or {}).get('spoken_name')
    return case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', required=True, help='store UUID')
    parser.add_argument('--output', required=True, help='output directory')
    parser.add_argument('--start', help='first business date (YYYY-MM-DD), inclusive')
    parser.add_argument('--end', help='last business date (YYYY-MM-DD), inclusive')
    parser.add_argument('--min-per-product', type=int, default=1)
    parser.add_argument('--max-per-product', type=int, default=1000000)
    parser.add_argument('--products', help='comma-separated product UUIDs')
    args = parser.parse_args()
    recognition(args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError) as error:
        print(f'export: {error}', file=sys.stderr)
        sys.exit(2)
