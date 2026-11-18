from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_RESIDENCY_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-residency-mutant-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
matching = scratch / 'src/yard-placement/matching.ts'
deploy = scratch / 'src/yard-placement/deploy.ts'
generation = scratch / 'src/yard-placement/generation.ts'
originals = {source: source.read_text() for source in [matching, deploy, generation]}
check = '\t\tconst jurisdiction = parseYardResidencyTag(entry);'
cases = [
    ('matching', matching, check, '\t\tif (yard.layout.residency.includes(entry)) return undefined;\n' + check,
     'test/yard-residency-validation.test.ts', 'rejects invalid atlantis even if'),
    ('request', deploy, '\t\t\t\tparseYardResidencyTag(entry);', '\t\t\t\t/* omit preflight */',
     'test/yard-residency-validation.test.ts', 'refuses invalid atlantis before preparing a quote'),
    ('planner', generation, 'if (!hasValidYardResidency(options.requestedLayout))',
     'if (false && !hasValidYardResidency(options.requestedLayout))',
     'test/yard-generation-residency.test.ts', 'refuses to plan an invalid tag atlantis'),
    ('saga', generation, 'if (!hasValidYardResidency(plan.requestedLayout))',
     'if (false && !hasValidYardResidency(plan.requestedLayout))',
     'test/yard-generation-residency.test.ts', 'does not call a connector for a self-consistent invalid plan'),
]

def run(test_file, pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        test_file, '--root', str(scratch), '--config', str(config),
        '--maxWorkers=1', '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, source, before, after, test_file, pattern in cases:
        original = originals[source]
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected exactly one source location')
        control = run(test_file, pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(original.replace(before, after))
        result = run(test_file, pattern)
        if result.returncode == 0 or f'FAIL  {test_file} >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
