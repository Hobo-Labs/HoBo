"""Exercise shared budget-policy guards in isolated runtime copies."""
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
source = repo / 'packages/core'
config = repo / '.agents/skills/verify-shared-budget-policy/models/vitest.config.mts'
test = 'test/budget-policy.property.test.ts'
cases = [
    ('null constraints', 'value.constraints === undefined ? [] : value.constraints', 'value.constraints ?? []'),
    ('context shape', 'if (!isJsonObject(context))', 'if (false)'),
    ('measurement collection', 'if (!Array.isArray(context.measurements))', 'if (false && !Array.isArray(context.measurements))'),
    ('measurement record', 'return refuse("budget.policy.measurement", "invalid trusted measurement");', 'void 0;'),
    ('projected cost', 'if (projected > BigInt(parsed.limitMicros))', 'if (false && projected > BigInt(parsed.limitMicros))'),
    ('native admission', 'if (requiresNativeBound && context.phase !== "plan")', 'if (false && requiresNativeBound && context.phase !== "plan")'),
]

def run(root):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test,
        '--root', str(root), '--config', str(config), '--maxWorkers=1', '--no-file-parallelism',
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

for name, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-shared-policy-mutant-') as temp:
        scratch = Path(temp) / 'core'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/ports/budget-policy.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site')
        target.write_text(original.replace(before, after, 1))
        result = run(scratch)
        if result.returncode == 0 or f'FAIL  {test} >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name}: expected a real-code test failure:\n{result.stdout}')
        print(f'Expected real-code failure: {name}', flush=True)

restored = run(source)
if restored.returncode:
    raise RuntimeError(f'restored policy checks failed:\n{restored.stdout}')
print('Restored policy checks passed', flush=True)
