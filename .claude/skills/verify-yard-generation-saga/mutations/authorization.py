"""Replay standalone authorization guard mutations against real saga tests."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_GENERATION_SAGA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base = Path(tempfile.mkdtemp(prefix='hobo-saga-authorization-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/generation.ts'
original = source.read_text()

def replace(s, before, after, count=1):
    if s.count(before) != count:
        raise RuntimeError(f'expected {count} instances of {before!r}, found {s.count(before)}')
    return s.replace(before, after)

def default_allow(s):
    s = replace(s, 'const authorize = options.authorizePlan;', 'const authorize = options.authorizePlan ?? (() => true);')
    return replace(s, 'options.authorizePlan === authorize', '(options.authorizePlan === undefined || options.authorizePlan === authorize)', 2)

def first_check(s):
    needle = 'if (!authorized())'
    if s.count(needle) != 2: raise RuntimeError('expected two authorization checks')
    return s.replace(needle, 'if (false)', 1)

def boundary_check(s):
    needle = 'if (!authorized())'
    if s.count(needle) != 2: raise RuntimeError('expected two authorization checks')
    pos = s.rfind(needle)
    return s[:pos] + s[pos:].replace(needle, 'if (false)', 1)

cases = [
    ('missing', default_allow, 'without an explicit host authorization'),
    ('initial', first_check, 'host decision denied'),
    ('cached', first_check, 'before returning a cached result'),
    ('boundary', boundary_check, 'revoked decision at the provider boundary'),
    ('decision-plan', lambda s: replace(s, 'contentHashOf(decisionPlan) === planDigest &&', ''), 'host decision mutates-plan'),
    ('decision-identity', lambda s: replace(s, 'options.authorizePlan === authorize', 'true', 2), 'host decision replaces-decision'),
    ('isolated-snapshot', lambda s: replace(s, 'const decisionPlan = structuredClone(plan);', 'const decisionPlan = plan;'), 'retained authorization input'),
]

def run(pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        'test/yard-generation-saga-authorization.test.ts', '--root', str(scratch),
        '--config', str(config), '--maxWorkers=1', '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, mutate, pattern in cases:
        control = run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(mutate(original))
        result = run(pattern)
        if result.returncode == 0 or 'FAIL  test/yard-generation-saga-authorization.test.ts >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
