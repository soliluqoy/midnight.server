"""Mutation score of the visible checks over the lines each real run changed.

For every pilot run: rebuild the final workspace, mutate only lines the run added or changed
(one operator site per mutant, unparsable mutants dropped), run the task's visible checks,
and record the fraction of mutants they kill. No model is run.
"""
import json, os, random, re, shutil, subprocess, sys, tempfile, collections
from concurrent.futures import ProcessPoolExecutor

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'harness')
RESULTS = [('pilot01', 'results/drift-pilot-01.recounted.jsonl'), ('pilot02', 'results/drift-pilot-02.no-db.jsonl')]
MAX_MUTANTS = 24
TEST_RE = re.compile(r'(^|/)(test[^/]*|[^/]*[._-]test\.[a-z]+|tests?/.*)$', re.I)

OPS = [
    (r'===', '!=='), (r'!==', '==='), (r'(?<![=!<>])==(?!=)', '!='), (r'!=(?!=)', '=='),
    (r'<=', '<'), (r'>=', '>'), (r'(?<![<=\-])<(?![<=])', '<='), (r'(?<![>=\-])>(?![>=])', '>='),
    (r' \+ ', ' - '), (r' - ', ' + '), (r' \* ', ' / '),
    (r'&&', '||'), (r'\|\|', '&&'), (r'\band\b', 'or'), (r'\bor\b', 'and'),
    (r'\btrue\b', 'false'), (r'\bfalse\b', 'true'), (r'\bTrue\b', 'False'), (r'\bFalse\b', 'True'),
    (r'(?<![\w.])(\d+)(?![\w.])', lambda m: str(int(m.group(1)) + 1)),
    (r'\breturn (?!;)(.+?);?$', lambda m: 'return undefined;'),
]


def mutants_for(text, changed_lines, py):
    lines = text.split('\n')
    out = []
    for i in changed_lines:
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith(('//', '#', '*', '/*')):
            continue
        for pat, rep in OPS:
            if py and pat.startswith(r'\breturn'):
                rep = lambda m: 'return None'
            for m in re.finditer(pat, line):
                new = line[:m.start()] + (rep(m) if callable(rep) else rep) + line[m.end():]
                if new != line:
                    out.append((i, new))
        # statement deletion
        indent = line[:len(line) - len(line.lstrip())]
        out.append((i, indent + ('pass' if py else '')))
    return out


def parses(path, py):
    cmd = [sys.executable, '-m', 'py_compile', path] if py else ['node', '--check', path]
    return subprocess.run(cmd, capture_output=True, timeout=20).returncode == 0


def run_checks(work, checks):
    for c in checks:
        cmd = list(c)
        if cmd[0] in ('python3', 'python'):
            cmd[0] = sys.executable
        if cmd[0] == 'npm':
            cmd[0] = 'npm.cmd'
        try:
            r = subprocess.run(cmd, cwd=work, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            return False
        if r.returncode != 0:
            return False
    return True


def changed_line_indexes(before, after):
    import difflib
    a = (before or '').split('\n')
    b = after.split('\n')
    idx = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ('replace', 'insert'):
            idx.extend(range(j1, j2))
    return idx


def score(job):
    src, rec = job
    task = rec['task']
    ev = rec['events'].replace('.jsonl', '.changes.json')
    if not os.path.exists(ev):
        return None
    changes = json.load(open(ev, encoding='utf8'))['changes']
    spec = json.load(open(os.path.join(ROOT, 'tasks', task, 'task.json'), encoding='utf8'))
    checks = [c['command'] for c in spec.get('checks', [])]
    work = tempfile.mkdtemp(prefix='mut-')
    try:
        shutil.copytree(os.path.join(ROOT, 'tasks', task, 'files'), work, dirs_exist_ok=True)
        for ch in changes:
            p = os.path.join(work, ch['path'])
            if ch.get('after') is None:
                if os.path.exists(p):
                    os.remove(p)
            else:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                open(p, 'w', encoding='utf8', newline='').write(ch['after'])
        visible = run_checks(work, checks)
        rng = random.Random(hash((task, rec['variant'], rec['repeat'], src)) & 0xffffffff)
        cands = []
        for ch in changes:
            if ch.get('after') is None or TEST_RE.search(ch['path']) or 'node_modules' in ch['path']:
                continue
            if not ch['path'].endswith(('.js', '.mjs', '.cjs', '.py')):
                continue
            py = ch['path'].endswith('.py')
            for i, new in mutants_for(ch['after'], changed_line_indexes(ch.get('before'), ch['after']), py):
                cands.append((ch['path'], py, i, new))
        rng.shuffle(cands)
        killed = tried = 0
        for path, py, i, new in cands:
            if tried >= MAX_MUTANTS:
                break
            p = os.path.join(work, path)
            original = open(p, encoding='utf8', newline='').read()
            lines = original.split('\n')
            lines[i] = new
            open(p, 'w', encoding='utf8', newline='').write('\n'.join(lines))
            try:
                if not parses(p, py):
                    continue
                tried += 1
                if not run_checks(work, checks):
                    killed += 1
            finally:
                open(p, 'w', encoding='utf8', newline='').write(original)
        return {'src': src, 'task': task, 'variant': rec['variant'], 'repeat': rec['repeat'],
                'success': bool(rec.get('success')), 'visible': visible, 'mutants': tried, 'killed': killed}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    jobs = []
    for src, p in RESULTS:
        for l in open(os.path.join(ROOT, p), encoding='utf8'):
            r = json.loads(l)
            if r.get('variant') == 'bare' or r['task'] == 'drift-db-unavailable':
                continue
            jobs.append((src, r))
    out = os.path.join(ROOT, 'results', 'mutscore.jsonl')
    with ProcessPoolExecutor(max_workers=8) as ex, open(out, 'w') as f:
        for res in ex.map(score, jobs):
            if res:
                f.write(json.dumps(res) + '\n')
                f.flush()
    print('wrote', out)


if __name__ == '__main__':
    main()
