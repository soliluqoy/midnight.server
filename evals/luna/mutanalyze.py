import json, collections, os, statistics
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'harness', 'results')
rows = [json.loads(l) for l in open(os.path.join(S, 'mutscore.jsonl'))]
rows = [r for r in rows if r['mutants'] > 0]
for r in rows:
    r['kill'] = r['killed'] / r['mutants']
print(f'runs with mutants: {len(rows)}  mean mutants/run {statistics.mean(r["mutants"] for r in rows):.1f}')
vis = [r for r in rows if r['visible']]
print(f'visible checks pass at the end: {len(vis)}; of those hidden-fail: {sum(not r["success"] for r in vis)}')

def auc(pos, neg):
    # P(score_pos > score_neg), ties half
    if not pos or not neg: return float('nan')
    s = 0.0
    for a in pos:
        for b in neg:
            s += 1.0 if a > b else 0.5 if a == b else 0.0
    return s / (len(pos) * len(neg))

fail = [1 - r['kill'] for r in vis if not r['success']]
ok = [1 - r['kill'] for r in vis if r['success']]
print(f'mean kill rate: hidden-pass {1-statistics.mean(ok):.2f}  hidden-fail {1-statistics.mean(fail):.2f}' if fail else 'no failures')
print(f'AUC (survival rate predicts hidden failure, pooled): {auc(fail, ok):.2f}')

print('\nper task: runs, hidden-fail among visible-pass, mean kill rate (pass / fail)')
bt = collections.defaultdict(list)
for r in vis: bt[r['task']].append(r)
for t, rs in sorted(bt.items(), key=lambda kv: statistics.mean(x['kill'] for x in kv[1])):
    f = [x['kill'] for x in rs if not x['success']]
    o = [x['kill'] for x in rs if x['success']]
    print(f'  {t:28s} n={len(rs):3d} fail={len(f):2d}  kill pass={statistics.mean(o) if o else float("nan"):.2f} fail={statistics.mean(f) if f else float("nan"):.2f}')

# within-task AUC: only tasks with both outcomes, pairs compared inside the task
pairs = tot = 0.0
for t, rs in bt.items():
    f = [1 - x['kill'] for x in rs if not x['success']]
    o = [1 - x['kill'] for x in rs if x['success']]
    if f and o:
        a = auc(f, o); pairs += a * len(f) * len(o); tot += len(f) * len(o)
print(f'\nwithin-task AUC (pairs inside tasks with both outcomes): {pairs/tot:.2f} over {int(tot)} pairs' if tot else '\nno task has both outcomes')

print('\nthreshold rule "flag when kill rate < t" among visible-pass runs')
for t in (0.3, 0.5, 0.7, 0.9):
    flagged = [r for r in vis if r['kill'] < t]
    caught = sum(not r['success'] for r in flagged)
    print(f'  t={t}: flags {len(flagged)}/{len(vis)} runs, catches {caught}/{len(fail)} hidden failures')
