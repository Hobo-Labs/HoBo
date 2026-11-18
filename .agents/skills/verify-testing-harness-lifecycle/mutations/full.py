from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-testing-harness-lifecycle'
cases = [
    ('unshared-teardown', 'src/harness.ts', 'if (entry.closing !== undefined) return entry.closing;', 'if (entry.closing !== undefined) return;'),
    ('unfenced-redeploy', 'src/harness.ts', 'await existing.closing;\n\t\t\treturn ensure(bindle);', 'states.delete(bindle);\n\t\t\treturn ensure(bindle);'),
    ('ignore-failed-teardown', 'src/harness.ts', 'if (existing?.closeFailure !== undefined) throw existing.closeFailure.cause;', ''),
    ('reuse-closed-graph', 'src/harness.ts', 'await existing.closing;\n\t\t\treturn ensure(bindle);', 'await existing.closing;\n\t\t\treturn existing.state;'),
    ('reentrant-start', 'src/harness.ts', 'const pending = Promise.resolve().then(async (): Promise<HarnessState> => {', 'const pending = (async (): Promise<HarnessState> => {'),
    ('skip-startup-cleanup', 'src/lanes/in-process.ts', 'await closeServers(opened);', 'void opened;'),
    ('drop-startup-fence', 'src/harness.ts', 'if (cause instanceof InProcessStartupCleanupError) {\n\t\t\t\tentry.closeFailure = { cause };', 'if (false && cause instanceof InProcessStartupCleanupError) {\n\t\t\t\tentry.closeFailure = { cause };'),
    ('ignore-cleanup-error', 'src/lanes/in-process.ts', 'if (failures.length > 0)', 'if (false)'),
    ('forget-teardown-error', 'src/harness.ts', 'entry.closeFailure = { cause };\n\t\t\t\t\t\tthrow cause;', 'throw cause;'),
]

def check(case):
    name, filename, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-testing-lifecycle-mutant-') as temp:
        source = repo / 'packages/testing'
        scratch = Path(temp) / 'testing'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        changed = original.replace(before, after, 1)
        if name == 'reentrant-start':
            end = '\n\t\t});\n\t\tconst entry: HarnessEntry = { state: pending };'
            if changed.count(end) != 1:
                raise RuntimeError(f'{name}: missing pending closure')
            changed = changed.replace(end, '\n\t\t})();\n\t\tconst entry: HarnessEntry = { state: pending };', 1)
        target.write_text(changed)
        env = {**os.environ, 'TESTING_LIFECYCLE_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if result.returncode == 0 or 'FAIL  test/' not in output or 'AssertionError' not in output or 'Failed Suites' in output:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:8000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('TESTING_LIFECYCLE_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass
restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
