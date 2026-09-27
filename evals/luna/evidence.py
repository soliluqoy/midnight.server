import json, collections, math, statistics, os

R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
def jl(p):
    with open(os.path.join(R, p), encoding='utf8') as f:
        return [json.loads(l) for l in f if l.strip()]

# 1. Verifier quality on constructed variants (laya-review states, real visible checks + hidden grader)
states = [s for s in jl(r'evals\laya-review\data\review-states.jsonl') if s['checks_context'] == 'checks']
by = collections.defaultdict(lambda: [0, 0, 0, 0])  # [incorrect, incorrect&visible-pass, correct, correct&visible-pass]
for s in states:
    vis = '[FAIL]' not in s['state']['change']['checks'] and 'nothing was run' not in s['state']['change']['checks']
    ok = s['labels']['addresses_request'] == 1
    v = s['variant'].split(':')[0]
    v = 'partial' if v.startswith('partial') else v
    key = v
    b = by[key]
    if ok:
        b[2] += 1; b[3] += vis
    else:
        b[0] += 1; b[1] += vis
print('== constructed variants: visible checks as a verifier ==')
tot = [0, 0, 0, 0]
for k, b in sorted(by.items()):
    tot = [x + y for x, y in zip(tot, b)]
    print(f'{k:28s} incorrect {b[0]:3d} pass-visible {b[1]:3d} ({b[1]/b[0]:.0%})' if b[0] else f'{k:28s} correct {b[2]:3d} pass-visible {b[3]:3d}')
print(f'ALL: eps(false accept)={tot[1]}/{tot[0]}={tot[1]/tot[0]:.2f}  rho(true accept)={tot[3]}/{tot[2]}={tot[3]/max(tot[2],1):.2f}')

# 2. Real runs
files = {
    'pilot01': r'evals\harness\results\drift-pilot-01.recounted.jsonl',
    'pilot02': r'evals\harness\results\drift-pilot-02.no-db.jsonl',
    'astra_drift': r'evals\harness\results\drift-astra-bare.jsonl',
    'luna_high_r3': r'evals\harness\results\luna-high-r3.jsonl',
    'astra_high_r3': r'evals\harness\results\astra-high-bare-r3.jsonl',
}
runs = []
for name, p in files.items():
    for r in jl(p):
        r['_src'] = name
        runs.append(r)

def model_of(r):
    if r['_src'].startswith('astra'): return 'astra'
    return 'luna'

print('\n== real runs: visible checks vs hidden grader ==')
grp = collections.defaultdict(list)
for r in runs:
    if r['_src'] in ('pilot01', 'pilot02', 'astra_drift') and r.get('task') == 'drift-db-unavailable':
        continue  # contaminated
    harness = r.get('variant') != 'bare'
    grp[(model_of(r), 'harness' if harness else 'bare')].append(r)
for k, rs in sorted(grp.items()):
    n = len(rs)
    succ = sum(bool(r.get('success')) for r in rs)
    vp = [r for r in rs if r.get('visiblePassed') is not None]
    fp = sum(1 for r in vp if r['visiblePassed'] and not r.get('artifactPassed'))
    inc = sum(1 for r in vp if not r.get('artifactPassed'))
    tp = sum(1 for r in vp if r['visiblePassed'] and r.get('artifactPassed'))
    cor = sum(1 for r in vp if r.get('artifactPassed'))
    cost = statistics.mean(r.get('cost', 0) for r in rs)
    el = statistics.median(r.get('elapsedMs', 0) for r in rs) / 1000
    tok = statistics.mean(r.get('input', 0) + r.get('output', 0) for r in rs)
    print(f'{k}: n={n} success={succ}/{n}={succ/n:.2f}  eps={fp}/{inc}  rho={tp}/{cor}  cost/run=${cost:.4f}  median {el:.0f}s  tokens/run {tok:.0f}')

# 3. Per-task heterogeneity for Luna+harness (pilot arms pooled): does repetition help (independence)?
print('\n== Luna + harness: per-task success, pass@k under heterogeneity ==')
per = collections.defaultdict(list)
for r in grp[('luna', 'harness')]:
    if r['_src'] in ('pilot01', 'pilot02'):
        per[r['task']].append(bool(r.get('success')))
ps = {t: sum(v) / len(v) for t, v in per.items()}
for t, p in sorted(ps.items(), key=lambda x: x[1]):
    print(f'  {t:30s} {sum(per[t])}/{len(per[t])}')
pbar = statistics.mean(ps.values())
for k in (1, 2, 3, 5):
    het = statistics.mean(1 - (1 - p) ** k for p in ps.values())
    ind = 1 - (1 - pbar) ** k
    print(f'  pass@{k}: heterogeneous {het:.3f}  if independent {ind:.3f}')
# intra-task correlation (ANOVA estimator)
vals = [(t, x) for t, v in per.items() for x in v]
N = len(vals); K = len(per); nbar = N / K
grand = sum(x for _, x in vals) / N
msb = sum(len(v) * (sum(v) / len(v) - grand) ** 2 for v in per.values()) / (K - 1)
msw = sum((x - sum(per[t]) / len(per[t])) ** 2 for t, x in vals) / (N - K)
icc = (msb - msw) / (msb + (nbar - 1) * msw)
print(f'  tasks={K} runs={N} mean p={grand:.3f} intra-task correlation={icc:.2f}')
