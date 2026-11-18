from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_GENERATION_SAGA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base = Path(tempfile.mkdtemp(prefix='hobo-generation-saga-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/generation.ts'
original = source.read_text()
cases = [
    ('coalescing', 'const pending = inFlight.get(key);', 'const pending = undefined;', 'test/yard-generation-saga-identity.test.ts', 'shares one pending provision'),
    ('identity', 'if (existing && existing.planDigest !== planDigest)', 'if (false)', 'test/yard-generation-saga-identity.test.ts', 'refuses a different plan reusing'),
    ('plan-snapshot', 'const plan = structuredClone(inputPlan);', 'const plan = inputPlan;', 'test/yard-generation-saga-identity.test.ts', 'snapshots the plan before awaiting'),
    ('method-pin', ': await provision.call(connector, plan);', ': await connector.provision(plan);', 'test/yard-generation-saga-identity.test.ts', 'pins the provider method'),
    ('result-snapshot', 'const result = structuredClone(value);', 'const result = value;', 'test/yard-generation-saga-identity.test.ts', 'snapshots a provider result'),
    ('resume-inspection', '? await inspect.call(connector, plan.attemptId)', '? await provision.call(connector, plan)', 'test/yard-placement-parsing.test.ts', 'an in-flight attempt is resumed through inspect'),
]

def run(test_file, pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test_file,
        '--root', str(scratch), '--config', str(config), '--maxWorkers=1',
        '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, guard, replacement, test_file, pattern in cases:
        if original.count(guard) != 1:
            raise RuntimeError(f'{name}: expected one guard')
        control = run(test_file, pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(original.replace(guard, replacement, 1))
        result = run(test_file, pattern)
        if result.returncode == 0 or f'FAIL  {test_file} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
