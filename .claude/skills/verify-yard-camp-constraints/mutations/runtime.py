from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_CAMP_CONSTRAINTS_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-camp-constraints-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
deploy = scratch / 'src/yard-placement/deploy.ts'
constraints = scratch / 'src/yard-placement/camp-constraints.ts'
matching = scratch / 'src/yard-placement/matching.ts'
generation = scratch / 'src/yard-placement/generation.ts'
originals = {source: source.read_text() for source in [deploy, constraints, matching, generation]}
guard = 'if (hasUnverifiedCampConstraints(request))'
test = 'test/yard-camp-constraints.test.ts'
cases = [
    ('quote', deploy, guard, 'if (false)', 2, 0, test, 'refuses unverified require before quote'),
    ('deploy', deploy, guard, 'if (false)', 2, 1, test, 'refuses unverified require before quote'),
    ('require', constraints, 'camp.require.length > 0 ||', 'false ||', 1, 0, test, 'refuses unverified require before quote'),
    ('runtime', constraints, 'camp.runtimeRequirements.length > 0 ||', 'false ||', 1, 0, test, 'refuses unverified runtimeRequirements before quote'),
    ('labels', constraints, 'Object.keys(camp.labels).length > 0', 'false', 1, 0, test, 'refuses unverified labels before quote'),
    ('nested-input', constraints, 'hasUnverifiedYardCamps(request.yard.requestedLayout) ||', 'false ||', 1, 0, test, 'refuses unverified yardCamps before quote'),
    ('matching', matching, 'if (hasUnverifiedYardCamps(request.requestedLayout))', 'if (false)', 1, 0, test, 'does not match nested Camp layouts'),
    ('subset', matching, 'if (hasUnverifiedYardCamps(requested)) return false;', 'if (false) return false;', 1, 0, test, 'does not match nested Camp layouts'),
    ('planner', generation, 'if (hasUnverifiedYardCamps(options.requestedLayout))', 'if (false)', 1, 0, test, 'refuses a nested Camp before creating a generation plan'),
    ('saga', generation, 'if (hasUnverifiedYardCamps(plan.requestedLayout))', 'if (false)', 1, 0, test, 'refuses a self-consistent older plan'),
    ('retry', generation, 'if (hasUnverifiedYardCamps(plan.requestedLayout))', 'if (false)', 1, 0, test, 'refuses a nested Camp retry'),
    ('funded', deploy, guard, 'if (false)', 2, 1, 'test/yard-event-store-folds.test.ts', 'unverified-camp-before-generation'),
]

def replace_one(text, before, after, count, index):
    if text.count(before) != count:
        raise RuntimeError(f'expected {count} source matches for {before!r}')
    start = -1
    for _ in range(index + 1):
        start = text.index(before, start + 1)
    return text[:start] + after + text[start + len(before):]

def run(test_file, pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test_file,
        '--root', str(scratch), '--config', str(config), '--maxWorkers=1',
        '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, source, before, after, count, index, test_file, pattern in cases:
        original = originals[source]
        control = run(test_file, pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(replace_one(original, before, after, count, index))
        result = run(test_file, pattern)
        if result.returncode == 0 or f'FAIL  {test_file} >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
