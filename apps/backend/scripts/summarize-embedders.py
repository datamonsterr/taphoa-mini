#!/usr/bin/env python3
"""Summarize saved recognition_eval observations using dataset class metadata."""
import argparse
import csv
import json
import struct
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('classes', type=Path)
parser.add_argument('observations', type=Path)
args = parser.parse_args()
with args.classes.open(newline='') as f:
    classes = list(csv.DictReader(f))
package_coarse = {row['Coarse Class ID (int)'] for row in classes if '/Packages/' in row['Iconic Image Path (str)']}
package_ids = {int(row['Class ID (int)']) for row in classes if row['Coarse Class ID (int)'] in package_coarse}
with args.observations.open() as f:
    data = json.load(f)
rows = data.get('observations') or data['configurations']['v2-k8']['observations']

def f32(value):
    return struct.unpack("f", struct.pack("f", value))[0]


def summarize(rows):
    known = [row for row in rows if not row['unknown']]
    amb = [row for row in known if row['scores'] and row['scores'][0][1] >= f32(0.6) and not (row['scores'][0][1] >= f32(0.8) and (len(row['scores']) == 1 or f32(row['scores'][0][1] - row['scores'][1][1]) >= f32(0.05)))]
    margin = [row for row in amb if row['scores'][0][1] >= f32(0.8) and len(row['scores']) > 1 and f32(row['scores'][0][1] - row['scores'][1][1]) < f32(0.05)]
    correct = lambda r: bool(r['scores']) and r['scores'][0][0] == r['truth']
    return {'known_n':len(known), 'top1_correct':sum(correct(r) for r in known), 'top5_correct':sum(any(s[0] == r['truth'] for s in r['scores']) for r in known), 'ambiguous_known_n':len(amb), 'ambiguous_top1_correct':sum(correct(r) for r in amb), 'margin_only_n':len(margin), 'margin_only_top1_correct':sum(correct(r) for r in margin), 'embed_ms_per_crop':sum(r['embed_ms'] for r in rows)/len(rows) if rows else None}
result = {'package_coarse_classes':sorted({row['Coarse Class Name (str)'] for row in classes if row['Coarse Class ID (int)'] in package_coarse}), 'package_class_ids':sorted(package_ids), 'groups':{}}
for name, subset in [('all', rows), ('packaged', [r for r in rows if r['truth'] in package_ids]), ('produce', [r for r in rows if r['truth'] not in package_ids])]:
    result['groups'][name] = {bucket:summarize([r for r in subset if bucket == 'all' or r['bucket'] == bucket]) for bucket in ('all','angle90','far','occlusion50','hard')}
print(json.dumps(result, separators=(',', ':')))
