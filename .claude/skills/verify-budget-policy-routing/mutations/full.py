"""Check recent budget guards against executable assertions in scratch copies."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-budget-policy-routing'
cases = [
    ('available-overflow', 'src/money.ts', 'return direction === "down" ? Number.MAX_VALUE : candidate;', 'return candidate;'),
    ('held-overflow', 'src/dispatcher.ts', '!Number.isFinite(totalHeld) || !Number.isFinite(totalUnits)', 'false || !Number.isFinite(totalUnits)'),
    ('unit-overflow', 'src/dispatcher.ts', '!Number.isFinite(totalHeld) || !Number.isFinite(totalUnits)', '!Number.isFinite(totalHeld) || false'),
    ('settlement-overflow', 'src/dispatcher.ts', 'if (!Number.isFinite(totalSpent))', 'if (false)'),
    ('estimate-exposure', 'src/money.ts', 'exposure = maxDecimal(exposure, decimal(estimatedCost));', 'exposure = fromQuote;'),
]

def check(case):
    name, filename, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-budget-review-mutant-') as temp:
        source = repo / 'packages/dispatcher'
        scratch = Path(temp) / 'dispatcher'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'BUDGET_ROUTER_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if result.returncode == 0 or 'FAIL  test/' not in output or 'AssertionError' not in output or 'Failed Suites' in output:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:8000]}\n...\n{output[-2000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('BUDGET_ROUTING_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass
restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
