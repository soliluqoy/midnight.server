"""Sequential verify-and-retry: success as a function of attempts n, verifier false-accept
rate eps, per-task success heterogeneity (Beta with mean m and intra-task correlation icc).

Per task with per-attempt success p: attempt until the verifier accepts or n attempts are used.
Correct attempts are accepted (rho = 1). Incorrect ones are accepted with probability eps.
P(success) = p * (1 - (1-q)^n) / q, with q = p + (1-p) * eps.
"""
import numpy as np

def beta_params(m, icc):
    s = (1 - icc) / icc          # a + b
    return m * s, (1 - m) * s

_cache = {}
def success(m, icc, eps, n):
    key = (m, icc)
    if key not in _cache:
        a, b = beta_params(m, icc)
        _cache[key] = np.random.default_rng(7).beta(a, b, 2_000_000)
    p = _cache[key]
    q = p + (1 - p) * eps
    q = np.maximum(q, 1e-12)
    return float(np.mean(p * (1 - (1 - q) ** n) / q))

print('Calibration on pilot data: Luna+harness, short tasks, m=0.924, icc=0.51, eps=1.0 (residual failures invisible)')
for n in (1, 2, 3, 5):
    print(f'  n={n}: {success(0.924, 0.51, 1.0, n):.3f}')

print('\nHard-task scenario (assumed): Luna single-attempt m=0.40, Astra high single-attempt 0.60, icc=0.5')
print('success of sequential verify-and-retry, rows eps, columns n')
print('eps   ' + ''.join(f'n={n:<6}' for n in (1, 2, 3, 5, 8)))
for eps in (1.0, 0.8, 0.5, 0.3, 0.2, 0.1, 0.05, 0.0):
    print(f'{eps:<5} ' + ''.join(f'{success(0.40, 0.5, eps, n):.3f}  ' for n in (1, 2, 3, 5, 8)))

print('\nSame with icc=0.3 (more diverse attempts)')
for eps in (0.8, 0.3, 0.1):
    print(f'{eps:<5} ' + ''.join(f'{success(0.40, 0.3, eps, n):.3f}  ' for n in (1, 2, 3, 5, 8)))

print('\nLargest eps at which n attempts reach 0.55 (Astra 0.60 minus 5 points), icc=0.5')
for n in (2, 3, 5, 8):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if success(0.40, 0.5, mid, n) >= 0.55: lo = mid
        else: hi = mid
    print(f'  n={n}: eps <= {lo:.2f}' if success(0.40, 0.5, 0.0, n) >= 0.55 else f'  n={n}: unreachable even with a perfect verifier')

print('\nCeiling with a perfect verifier and unlimited attempts is P(p > 0) = 1 under Beta; at n=8:')
print('  icc=0.5:', round(success(0.40, 0.5, 0.0, 8), 3), ' icc=0.7:', round(success(0.40, 0.7, 0.0, 8), 3))
