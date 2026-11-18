"""Exercise maintenance projection on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-status-page-maintenance'
cases = [
    ('terminal-guard', 'src/types.ts', 'if (current === "completed" || current === "canceled") return current;', '', 1, 0),
    ('pending-update', 'src/projection.ts', 'if (!existing) {', 'if (!existing) return touch(base, event, {});\n\tif (!existing) {', 1, 0),
    ('pending-apply', 'src/projection.ts', 'existing?.state ?? pendingState ?? "scheduled"', 'existing?.state ?? "scheduled"', 1, 0),
    ('pending-isolation', 'src/projection.ts', 'const pendingStates = { ...base.pendingMaintenanceStates };', 'const pendingStates = {};', 2, 1),
    ('pending-consume', 'src/projection.ts', 'delete pendingStates[data.maintenanceId];', '', 1, 0),
    ('invalid-update', 'src/projection.ts', 'if (next === undefined) return touch(base, event, {});', '', 1, 0),
]

def check(case):
    name, relative, before, after, count, index = case
    with tempfile.TemporaryDirectory(prefix='hobo-status-maintenance-mutant-') as temp:
        scratch = Path(temp) / 'status-page'
        source = repo / 'packages/status-page'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / relative
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} mutation sites, found {original.count(before)}')
        offset = 0
        for _ in range(index + 1):
            offset = original.index(before, offset) + len(before)
        target.write_text(original[:offset - len(before)] + after + original[offset:])
        env = {**os.environ, 'STATUS_MAINTENANCE_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/maintenance-lifecycle.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('STATUS_MAINTENANCE_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
