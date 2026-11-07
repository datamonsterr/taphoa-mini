#!/usr/bin/env python3
"""Class-disjoint B5 calibration. Fit once; the held half never selects thresholds.

Usage: python fit-recognition-thresholds.py CHALLENGER.json GALLERY.json OUTPUT.json
Requires numpy==1.26.4 only for gallery scoring. No inference or model weights needed.
"""
import hashlib
import json
from pathlib import Path
import sys
import struct

SEED = 20261102
TARGET_PERCENT = 95
DUPLICATE_TARGET_PERCENT = 97
KNOWN_RECALL_PERCENT = 95


def split_classes(rows):
    """Split each known/unknown stratum by seeded hash; all transforms stay together."""
    fit, held = [], []
    for unknown in [False, True]:
        classes = sorted({r['truth'] for r in rows if r['unknown'] == unknown},
                         key=lambda c: hashlib.sha256(f'{SEED}:{c}'.encode()).digest())
        fit.extend(classes[:len(classes)//2])
        held.extend(classes[len(classes)//2:])
    return sorted(fit), sorted(held)


def f32(value):
    return struct.unpack('f', struct.pack('f',value))[0]


def query_points(rows):
    return [(f32(r['scores'][0][1]), f32(f32(r['scores'][0][1]) - f32(r['scores'][1][1]))
             if len(r['scores']) > 1 else 1.,
             not r['unknown'] and r['scores'][0][0] == r['truth'])
            for r in rows if r['scores']]


def fit_match(points, target_percent=TARGET_PERCENT):
    """Exact score/gap boundaries; maximize matches at the requested fit precision.

    Deterministic tie break: lower margin, then higher threshold. No held data here.
    """
    points = sorted(points, reverse=True)
    margins = sorted({0.} | {max(0., p[1]) for p in points})
    slots = {m: i for i, m in enumerate(margins)}
    counts = [[0, 0] for _ in margins]
    best = None
    i = 0
    while i < len(points):
        threshold = points[i][0]
        while i < len(points) and points[i][0] == threshold:
            _, gap, correct = points[i]
            slot = counts[slots[max(0., gap)]]
            slot[0] += 1
            slot[1] += int(correct)
            i += 1
        matched = correct = 0
        for j in range(len(margins)-1, -1, -1):
            matched += counts[j][0]
            correct += counts[j][1]
            key = (matched, -margins[j], threshold)
            if matched and correct * 100 >= target_percent * matched:
                if best is None or key > best[0]:
                    best = (key, dict(threshold=threshold, margin=margins[j],
                                      matched=matched, correct=correct))
    if best is None:
        raise ValueError('No nonempty rule reaches the fit precision target')
    return best[1]


def fit_floor(rows, threshold):
    """Highest floor retaining >=95% of known fit queries; unknown scores never fit it."""
    known = [r for r in rows if not r['unknown']]
    scores = sorted(f32(r['scores'][0][1]) for r in known if r['scores'])
    if not known or len(scores)*100 < KNOWN_RECALL_PERCENT*len(known):
        raise ValueError('not enough known queries with scores to retain 95 percent')
    missing = len(known)-len(scores)
    allowed_rejections = len(known)*(100-KNOWN_RECALL_PERCENT)//100
    floor = min(threshold,scores[allowed_rejections-missing])
    if floor < 0:
        raise ValueError('95 percent known recall is infeasible with a nonnegative floor')
    return floor


def query_metrics(rows, rule):
    points = query_points(rows)
    matched = [p for p in points if p[0] >= rule['threshold'] and p[1] >= rule['margin']]
    correct = sum(p[2] for p in matched)
    unknown = sum(r['unknown'] for r in rows)
    rejected = [r for r in rows if not r['scores'] or f32(r['scores'][0][1]) < rule['floor']]
    unknown_rejected = sum(r['unknown'] for r in rejected)
    known = len(rows)-unknown
    known_retained = sum(not r['unknown'] and bool(r['scores']) and
                         f32(r['scores'][0][1]) >= rule['floor'] for r in rows)
    return dict(queries=len(rows), known_queries=known,
                known_at_or_above_floor=known_retained,
                known_recall_at_floor=known_retained/known if known else None,
                matched=len(matched), correct=correct,
                precision=correct/len(matched) if matched else None,
                coverage=len(matched)/len(rows),
                unknown_queries=unknown, unknown_rejected=unknown_rejected,
                unknown_recall=unknown_rejected/unknown if unknown else None,
                ambiguous=len(rows)-len(matched)-len(rejected))


def duplicate_observations(gallery, classes):
    """Leave one source photo (all seven views) out, then reproduce K=8 voting.

    One original view per gallery photo is the enrollment query. Both reference and
    candidate classes are confined to the calibration half. Same product is positive;
    other returned top-5 products are negative. Prototypes omit the source photo too.
    """
    import numpy as np
    classes = sorted(classes)
    vectors = {c: np.asarray(gallery[c], dtype=np.float64) for c in classes}
    for v in vectors.values():
        if len(v) % 7 or len(v) < 14:
            raise ValueError('expected at least two photos with seven views each')
    matrix = np.concatenate([vectors[c] for c in classes])
    matrix /= np.linalg.norm(matrix,axis=1,keepdims=True)
    labels = np.concatenate([np.full(len(vectors[c]),c) for c in classes])
    offsets = dict(zip(classes, np.cumsum([0]+[len(vectors[c]) for c in classes[:-1]])))
    prototypes = {c: vectors[c].mean(axis=0) for c in classes}
    for c in classes:
        prototypes[c] /= np.linalg.norm(prototypes[c])
    rows = []
    for truth in classes:
        for photo in range(len(vectors[truth])//7):
            start = photo*7
            query = matrix[offsets[truth]+start]
            cosine = matrix @ query
            cosine[offsets[truth]+start:offsets[truth]+start+7] = -np.inf
            # Exact scan size=560, budget=20, top-three cap, product-ID tie breaks.
            nearest = np.lexsort((labels,-cosine))[:560]
            votes, count = {}, {}
            total = 0
            for index in nearest:
                if not np.isfinite(cosine[index]):
                    continue
                candidate = int(labels[index])
                if count.get(candidate,0) == 3:
                    continue
                if total == 20:
                    break
                count[candidate] = count.get(candidate,0)+1
                total += 1
                votes[candidate] = f32(votes.get(candidate,0.) + f32(f32(cosine[index])/3))
            for candidate in classes:
                if candidate in votes:
                    continue
                prototype = prototypes[candidate]
                if candidate == truth:
                    rest = np.concatenate((vectors[truth][:start],vectors[truth][start+7:]))
                    prototype = rest.mean(axis=0)
                    prototype /= np.linalg.norm(prototype)
                votes[candidate] = f32(query @ prototype)
            for candidate, score in sorted(votes.items(),key=lambda p:(-p[1],p[0]))[:5]:
                rows.append(dict(truth=truth, photo=photo, candidate=candidate,
                                 score=score, same_product=candidate==truth))
    return rows


def fit_duplicate(rows):
    best = None
    correct = matched = 0
    points = sorted([(r['score'],r['same_product']) for r in rows],reverse=True)
    i = 0
    while i < len(points):
        threshold = points[i][0]
        while i < len(points) and points[i][0] == threshold:
            correct += int(points[i][1]); matched += 1; i += 1
        if correct*100 >= DUPLICATE_TARGET_PERCENT*matched:
            best = dict(threshold=threshold, correct=correct, matched=matched)
    if best is None:
        raise ValueError('No duplicate threshold reaches target')
    return best


def duplicate_metrics(rows, threshold):
    accepted = [r for r in rows if r['score'] >= threshold]
    correct = sum(r['same_product'] for r in accepted)
    queries = len({(r['truth'],r['photo']) for r in rows})
    return dict(queries=queries, candidate_pairs=len(rows), accepted=len(accepted),
                correct=correct, precision=correct/len(accepted) if accepted else None,
                same_product_recall=correct/queries if queries else None)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    observations, gallery_path, output = map(Path,sys.argv[1:])
    data = json.loads(observations.read_text())
    rows = data['observations']
    fit_classes, held_classes = split_classes(rows)
    fit = [r for r in rows if r['truth'] in fit_classes]
    held = [r for r in rows if r['truth'] in held_classes]
    match_rules = {}
    for target in [95,97]:
        rule = fit_match(query_points(fit),target)
        rule['floor'] = fit_floor(fit,rule['threshold'])
        match_rules[str(target)] = dict(rule=rule,fit=query_metrics(fit,rule),
                                       held=query_metrics(held,rule))
    rule = match_rules[str(TARGET_PERCENT)]['rule']
    gallery = {int(k):v for k,v in json.loads(gallery_path.read_text())['entries'].items()}
    duplicate_fit = duplicate_observations(gallery,set(fit_classes)&gallery.keys())
    duplicate_held = duplicate_observations(gallery,set(held_classes)&gallery.keys())
    duplicate = fit_duplicate(duplicate_fit)
    result = dict(seed=SEED,target_precision=TARGET_PERCENT/100,
                  duplicate_target_precision=DUPLICATE_TARGET_PERCENT/100,
                  floor_target_known_recall=KNOWN_RECALL_PERCENT/100,
                  match_rules=match_rules,
                  model_sha256=data['model_sha256'],
                  inputs=dict(observations_sha256=digest(observations),gallery_sha256=digest(gallery_path)),
                  fit_classes=fit_classes,held_classes=held_classes,
                  match_rule=rule, fit=query_metrics(fit,rule),held=query_metrics(held,rule),
                  duplicate_rule=duplicate,
                  duplicate_fit=duplicate_metrics(duplicate_fit,duplicate['threshold']),
                  duplicate_held=duplicate_metrics(duplicate_held,duplicate['threshold']),
                  duplicate_observations=dict(fit=duplicate_fit,held=duplicate_held),
                  limitations=['Class-disjoint query evaluation on synthetic GroceryStoreDataset crops; not shop photos.',
                               'Exact cosine voting; production HNSW recall is not measured.',
                               'Per-observation counts share source photos and are correlated.',
                               'Duplicate queries exclude their source photo and all its augmentations.',
                               'Duplicate candidates use disjoint gallery halves; no held class images fit thresholds.'])
    output.write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
    print(json.dumps(result,indent=2))

if __name__ == '__main__':
    main()
