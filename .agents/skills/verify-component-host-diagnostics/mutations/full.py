"""Exercise diagnostic snapshots on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-component-host-diagnostics'
cases = [
    ('lifecycle-record', '? { ...lifecycle }', '? lifecycle'),
    ('sink-record', 'const mirrorEvent = { ...event };', 'const mirrorEvent = event;'),
    ('returned-array', 'return this.#eventMirror.map((event) => ({ ...event }));', 'return this.#eventMirror;'),
    ('returned-record', 'return this.#eventMirror.map((event) => ({ ...event }));', 'return [...this.#eventMirror];'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-component-diagnostics-mutant-') as temp:
        scratch = Path(temp) / 'runtime-local'
        source = repo / 'packages/runtimes/runtime-local'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/component-host.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'COMPONENT_DIAGNOSTICS_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/component-host-diagnostics.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('COMPONENT_DIAGNOSTICS_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
