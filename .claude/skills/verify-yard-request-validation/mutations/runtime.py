from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_REQUEST_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-request-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/deploy.ts'
original = source.read_text()

estimate = '''\tif (
\t\t!isJsonNumber(raw.spendEstimateUsd) ||
\t\t!Number.isFinite(raw.spendEstimateUsd) ||
\t\traw.spendEstimateUsd < 0
\t)
\t\tthrow new TypeError(
\t\t\t"spendEstimateUsd must be present, finite, and nonnegative",
\t\t);
'''
yard_id = '''\tif (
\t\tyardRaw.requestedYardId !== undefined &&
\t\t(!isJsonString(yardRaw.requestedYardId) || !yardRaw.requestedYardId.trim())
\t)
\t\tthrow new TypeError("requestedYardId must be a nonempty string");
'''
bindle_lists = '''\tvalidateConstraintLists(
\t\treqs,
\t\t["require", "prefer", "runtimes"],
\t\t"bindleRequirements",
\t);
'''
selection = '''\tthrow new TypeError(
\t\t"selectionMode must be exact, compatible, or compatible-or-generate",
\t);'''
cases = [
    ('estimate', estimate, '', 'requires a finite, nonnegative explicit estimate'),
    ('selection', selection, '\treturn "compatible";', 'rejects unrecognized explicit Yard and Camp'),
    ('yard', '\tvalidateRequestedYardLayout(yardRaw.requestedLayout);', '', 'refuses malformed residency before'),
    ('yard-id', yard_id, '', 'rejects malformed label maps and nested Camp declarations'),
    ('bindle-lists', bindle_lists, '', 'refuses malformed constraints instead'),
    ('bindle-labels', '\tvalidateConstraintLabels(reqs.labels, "bindleRequirements.labels");', '', 'rejects malformed label maps and nested Camp declarations'),
    ('camp', '\t\tvalidateRequestedCampLayout(raw.camp.layout, "camp.layout");', '', 'refuses malformed constraints instead'),
]

def run(pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        'test/yard-request-validation.test.ts', '--root', str(scratch), '--config', str(config),
        '--maxWorkers=1', '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, before, after, pattern in cases:
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected exactly one source match')
        control = run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(original.replace(before, after))
        result = run(pattern)
        if result.returncode == 0 or 'FAIL  test/yard-request-validation.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
