"""Exercise signal ordering and label validation on broken scratch code."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-status-page-signal-order'
cases = [
    ('late-label', '? (existing?.label ?? data.componentLabel ?? data.componentId)', '? (data.componentLabel ?? existing?.label ?? data.componentId)'),
    ('label-type', 'isStringValue(componentLabel)', 'true'),
    ('label-empty', 'componentLabel.length > 0', 'true'),
    ('late-status', 'status: isLate ? (existing?.status ?? status) : status,', 'status: status,'),
    ('late-time', '? (existing?.lastSignalAt ?? data.measuredAt)', '? data.measuredAt'),
    ('late-attainment', 'attainment: isLate ? (existing?.attainment ?? attainment) : attainment,', 'attainment: attainment,'),
    ('late-target', 'target: isLate ? (existing?.target ?? data.target) : data.target,', 'target: data.target,'),
    ('late-history', 'date === undefined\n', 'date === undefined || isLate\n'),
    ('tie-order', 'Date.parse(data.measuredAt) < Date.parse(existing.lastSignalAt)', 'Date.parse(data.measuredAt) <= Date.parse(existing.lastSignalAt)'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-status-signal-order-mutant-') as temp:
        scratch = Path(temp) / 'status-page'
        source = repo / 'packages/status-page'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/projection.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'STATUS_SIGNAL_ORDER_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/signal-order.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('STATUS_SIGNAL_ORDER_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
