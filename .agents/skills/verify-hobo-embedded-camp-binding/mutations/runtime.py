from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('HOBO_EMBEDDED_CAMP_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-embedded-camp-mutants-'))
scratch = base / 'hobo'
shutil.copytree(repo / 'packages/hobo', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/hobo/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
source = scratch / 'src/broker-runtime.ts'
original = source.read_text()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'

def replace(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError(f'expected exactly one source match: {before!r}')
    return text.replace(before, after)

def late_capture(text):
    text = replace(text, '\tconst requestedCampId = options.campId;\n', '')
    return replace(text, '\tconst baseRequest = buildDeploymentRequestFromParts({',
                   '\tconst requestedCampId = options.campId;\n\tconst baseRequest = buildDeploymentRequestFromParts({')

def live_rejection(text):
    before = 'campId: requestedCampId ?? "unplaced",'
    if text.count(before) != 3:
        raise RuntimeError('expected three rejection Camp fields')
    return text.replace(before, 'campId: options.campId ?? "unplaced",')

cases = [
    ('capture', late_capture, 'keeps the requested Camp when the caller changes'),
    ('rejection', live_rejection, 'reports the original Camp when a changed request is rejected'),
    ('forward', lambda s: replace(s, 'requestedCampId === undefined', 'true || requestedCampId === undefined'), 'rejects an explicit Camp in a different Yard'),
    ('return', lambda s: replace(s, 'const campId = receipt.selectedCampId;', 'const campId = options.campId ?? receipt.selectedCampId;'), 'returns the same explicit Camp'),
]

def run(pattern=None):
    args = ['node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', 'test/embedded-camp-binding.test.ts', '--root', str(scratch), '--config', str(config), '--maxWorkers=1', '--no-file-parallelism']
    if pattern is not None:
        args.extend(['-t', pattern])
    return subprocess.run(args, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    control = run()
    if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
        raise RuntimeError(f'unmodified control failed: {control.stdout[-5000:]}')
    print('Unmodified control passed', flush=True)
    for name, mutate, pattern in cases:
        source.write_text(mutate(original))
        result = run(pattern)
        if result.returncode == 0 or 'FAIL  test/embedded-camp-binding.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
