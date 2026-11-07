"""Fixture-only integration test; set DATASET_TEST_DATABASE_URL and local S3 env."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid
from urllib.parse import quote


@unittest.skipUnless(os.getenv('DATASET_TEST_DATABASE_URL'), 'local test database not configured')
class ExportIntegration(unittest.TestCase):
    def test_recognition_and_voice(self):
        import boto3
        import psycopg
        from botocore.config import Config

        schema = 'dataset_test_' + uuid.uuid4().hex
        bucket = 'dataset-test-' + uuid.uuid4().hex
        base = os.environ['DATASET_TEST_DATABASE_URL']
        s3 = boto3.client('s3', endpoint_url=os.environ['AWS_ENDPOINT_URL'],
                          region_name=os.environ['AWS_DEFAULT_REGION'], config=Config(s3={'addressing_style': 'path'}))
        store, prod, ref, scan, det, sale, utterance = [str(uuid.uuid4()) for _ in range(7)]
        s3.create_bucket(Bucket=bucket)
        try:
            with psycopg.connect(base, autocommit=True) as db:
                db.execute(f'CREATE SCHEMA {schema}')
                db.execute(f'SET search_path TO {schema}')
                db.execute('''CREATE TABLE products(id uuid, store_id uuid, name text);
                  CREATE TABLE images(id uuid, store_id uuid, object_key text);
                  CREATE TABLE product_images(product_id uuid, image_id uuid, position int, bbox real[]);
                  CREATE TABLE scans(id uuid, store_id uuid, image_id uuid, purpose text);
                  CREATE TABLE detections(id uuid, store_id uuid, scan_id uuid, crop_image_id uuid, bbox real[]);
                  CREATE TABLE sales(id uuid, store_id uuid, status text, business_date date, sold_at timestamptz);
                  CREATE TABLE sale_lines(product_id uuid, store_id uuid, sale_id uuid, detection_id uuid, position int, quantity int, unit_price bigint, manual_label text);
                  CREATE TABLE voice_utterances(id uuid, store_id uuid, transcript text, language text, draft jsonb, corrections jsonb, sale_id uuid, donated bool, intent text, outcome text, created_at timestamptz);''')
                db.execute('INSERT INTO products VALUES (%s,%s,%s)', (prod, store, 'Coca'))
                db.execute('INSERT INTO images VALUES (%s,%s,%s),(%s,%s,%s)', (ref, store, 'ref', scan, store, 'scan'))
                db.execute('INSERT INTO product_images VALUES (%s,%s,0,NULL)', (prod, ref))
                db.execute("INSERT INTO scans VALUES (%s,%s,%s,'checkout')", (det, store, scan))
                db.execute('INSERT INTO detections VALUES (%s,%s,%s,NULL,ARRAY[0,0,1,1]::real[])', (det, store, det))
                db.execute("INSERT INTO sales VALUES (%s,%s,'completed','2026-01-01',now())", (sale, store))
                db.execute('INSERT INTO sale_lines VALUES (%s,%s,%s,%s,0,2,10000,NULL)', (prod, store, sale, det))
                draft = {'payment_method': 'cash', 'lines': [{'id': str(uuid.uuid4()), 'spoken': 'coca', 'product': {'id': prod, 'name': 'Coca'}, 'quantity': 2, 'unit_price': 10000, 'price_source': 'catalog'}]}
                db.execute("INSERT INTO voice_utterances VALUES (%s,%s,'hai coca','vi',%s,'[]',%s,true,'sale','confirmed',now())", (utterance, store, json.dumps(draft), sale))
            for key in ['ref', 'scan', f'voice/{store}/{utterance}.m4a']:
                s3.put_object(Bucket=bucket, Key=key, Body=b'fixture')
            env = os.environ.copy()
            env.update(DATABASE_URL=base + ('&' if '?' in base else '?') + 'options=' + quote(f'-csearch_path={schema}'), AWS_S3_BUCKET_NAME=bucket)
            scripts = pathlib.Path(__file__).resolve().parents[1]
            with tempfile.TemporaryDirectory() as tmp:
                recog, voice = pathlib.Path(tmp) / 'a1', pathlib.Path(tmp) / 'voice'
                subprocess.run([scripts / 'export-recognition-set.sh', '--store', store, '--output', recog], env=env, check=True)
                manifest = json.loads((recog / 'manifest.json').read_text())
                self.assertEqual(len(manifest['references']), 1)
                self.assertEqual(manifest['queries'][0]['bbox'], [0, 0, 1, 1])
                cmd = [scripts / 'export-voice-golden.sh', '--store', store, '--output', voice]
                subprocess.run(cmd, env=env, check=True)
                sidecar = voice / (utterance + '.json')
                data = json.loads(sidecar.read_text())
                self.assertEqual(data['review_status'], 'unreviewed')
                self.assertEqual(data['original_draft'], draft)
                self.assertEqual(data['confirmed_sale_lines'][0]['quantity'], 2)
                data['review_status'] = 'reviewed'
                sidecar.write_text(json.dumps(data))
                subprocess.run(cmd, env=env, check=True)
                self.assertEqual(json.loads(sidecar.read_text())['review_status'], 'reviewed')
        finally:
            with psycopg.connect(base, autocommit=True) as db:
                db.execute(f'DROP SCHEMA IF EXISTS {schema} CASCADE')
            for item in s3.list_objects_v2(Bucket=bucket).get('Contents', []):
                s3.delete_object(Bucket=bucket, Key=item['Key'])
            s3.delete_bucket(Bucket=bucket)
