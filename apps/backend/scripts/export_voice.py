#!/usr/bin/env python3
"""Export donated recordings and provisional labels for human review."""
import argparse
import json
import os
import pathlib
import subprocess
import tempfile
import uuid

import boto3
import psycopg
from botocore.config import Config
from botocore.exceptions import ClientError
from psycopg.rows import dict_row

from dataset_export import voice_case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', required=True, help='store UUID')
    parser.add_argument('--output', required=True, help='output directory')
    args = parser.parse_args()
    store = str(uuid.UUID(args.store))
    root = pathlib.Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as db:
        db.execute('SET TRANSACTION READ ONLY')
        rows = db.execute('''SELECT v.id::text, v.transcript, v.language, v.draft, v.corrections,
            (SELECT COALESCE(jsonb_object_agg(p.id::text, p.name), '{}'::jsonb)
             FROM products p WHERE p.store_id=v.store_id AND p.name IS NOT NULL) product_names,
            (SELECT jsonb_agg(jsonb_build_object('product_id', sl.product_id, 'quantity', sl.quantity,
                     'unit_price', sl.unit_price, 'manual_label', sl.manual_label) ORDER BY sl.position)
             FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id AND s.store_id=sl.store_id
             WHERE s.id=v.sale_id AND s.store_id=v.store_id AND s.status='completed') confirmed_sale_lines
            FROM voice_utterances v WHERE v.store_id=%s AND v.donated
              AND v.intent='sale' AND v.outcome IN ('confirmed','edited') AND v.draft IS NOT NULL
            ORDER BY v.created_at, v.id''', (store,)).fetchall()
    s3 = boto3.client('s3', endpoint_url=os.environ['AWS_ENDPOINT_URL'],
        region_name=os.environ['AWS_DEFAULT_REGION'],
        config=Config(s3={'addressing_style': 'path' if os.getenv('S3_FORCE_PATH_STYLE', '').lower() == 'true' else 'virtual'}))
    bucket = os.environ['AWS_S3_BUCKET_NAME']
    exported, skipped = [], 0
    for row in rows:
        case_id = row['id']
        sidecar, audio = root / (case_id + '.json'), root / (case_id + '.m4a')
        if sidecar.exists() and audio.exists():
            exported.append(case_id)
            skipped += 1
            continue
        if sidecar.exists() or audio.exists():
            raise RuntimeError(f'{case_id}: incomplete export; resolve existing files before retrying')
        case = voice_case(row)
        with tempfile.TemporaryDirectory(dir=root) as tmp:
            original = pathlib.Path(tmp) / 'source'
            for ext in ('m4a', 'wav', 'ogg'):
                try:
                    s3.download_file(bucket, f'voice/{store}/{case_id}.{ext}', str(original))
                    break
                except ClientError as error:
                    if error.response['Error']['Code'] not in ('404', 'NoSuchKey', 'NotFound'):
                        raise
            else:
                print(f'{case_id}: donated audio missing; skipped')
                continue
            converted = pathlib.Path(tmp) / 'audio.m4a'
            if ext == 'm4a':
                original.replace(converted)
            else:
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(original), '-c:a', 'aac', str(converted)], check=True)
            new_sidecar = pathlib.Path(tmp) / 'case.json'
            new_sidecar.write_text(json.dumps(case, ensure_ascii=False, indent=2) + '\n')
            converted.replace(audio)
            new_sidecar.replace(sidecar)
        exported.append(case_id)
    metadata = root / 'metadata'
    metadata.mkdir(exist_ok=True)
    all_ids = sorted(p.stem for p in root.glob('*.json') if (root / (p.stem + '.m4a')).exists())
    (metadata / 'manifest.json').write_text(json.dumps({'ids': all_ids}, indent=2) + '\n')
    print(f'Voice clips: {len(exported)} ({skipped} already exported); review every new clip before evaluation.')


if __name__ == '__main__':
    main()
