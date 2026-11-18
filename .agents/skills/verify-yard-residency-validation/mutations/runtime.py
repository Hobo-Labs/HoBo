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
source = scratch / 'src/yard-placement/matching.ts'
original = source.read_text()
before = '\tconst separator = entry.indexOf(":");'
after = '\tif (yard.layout.residency.includes(entry)) return undefined;\n' + before

def run():
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        'test/yard-residency-validation.test.ts', '--root', str(scratch), '--config', str(config),
        '--maxWorkers=1', '--no-file-parallelism', '-t', 'does not ask the host to authorize',
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    if original.count(before) != 1:
        raise RuntimeError('expected exactly one residency parser location')
    control = run()
    if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
        raise RuntimeError(f'control failed: {control.stdout[-5000:]}')
    print('Control passed', flush=True)
    source.write_text(original.replace(before, after))
    result = run()
    if result.returncode == 0 or 'FAIL  test/yard-residency-validation.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
        raise RuntimeError(f'expected assertion failure missing: {result.stdout[-5000:]}')
    print('Expected real-code failure: invalid attestation reached authorization', flush=True)
finally:
    shutil.rmtree(base)
