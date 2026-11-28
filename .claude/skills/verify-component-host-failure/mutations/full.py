"""Exercise local host failure handling on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-component-host-failure'
cases = [
    ('poison', 'this.#sinkFailed = true;', '', 1, 0),
    ('poison-check', 'if (this.#sinkFailed)', 'if (false)', 2, 1),
    ('reentrant-check', 'if (this.#emitting)', 'if (false)', 1, 0),
    ('reentrant-mark', 'this.#emitting = true;', '', 1, 0),
    ('reentrant-release', 'this.#emitting = false;', '', 1, 0),
    ('async-sink', 'returned === result && returned.then instanceof Function', 'false', 1, 0),
    ('provider-entry', 'this.#requireAvailable();', '', 7, 0),
    ('load-entry', 'this.#requireAvailable();', '', 7, 1),
    ('link-entry', 'this.#requireAvailable();', '', 7, 2),
    ('linked-entry', 'this.#requireAvailable();', '', 7, 3),
    ('http-entry', 'this.#requireAvailable();', '', 7, 4),
    ('teardown-entry', 'this.#requireAvailable();', '', 7, 5),
    ('append-entry', 'this.#requireAvailable();', '', 7, 6),
    ('propagate-uncertainty', 'if (this.#sinkFailed)', 'if (false)', 2, 0),
    ('busy-guard', 'if ((this.#inFlight.get(componentId) ?? 0) > 0)', 'if (false)', 1, 0),
    ('linked-claim', 'const release = this.#beginInvocation(componentId);', 'const release = () => {};', 2, 0),
    ('http-claim', 'const release = this.#beginInvocation(componentId);', 'const release = () => {};', 2, 1),
    ('linked-release', 'release();', '', 2, 0),
    ('http-release', 'release();', '', 2, 1),
]

def check(case):
    name, before, after, count, index = case
    with tempfile.TemporaryDirectory(prefix='hobo-component-failure-mutant-') as temp:
        scratch = Path(temp) / 'runtime-local'
        source = repo / 'packages/runtimes/runtime-local'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/component-host.ts'
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} mutation sites, found {original.count(before)}')
        offset = 0
        for _ in range(index + 1):
            offset = original.index(before, offset) + len(before)
        start = offset - len(before)
        changed = original[:start] + after + original[offset:]
        if name == 'propagate-uncertainty':
            append_guard = '#append(event: ComponentHostEvent): void {\n\t\tthis.#requireAvailable();'
            if changed.count(append_guard) != 1:
                raise RuntimeError('propagate-uncertainty: expected append guard')
            changed = changed.replace(append_guard, '#append(event: ComponentHostEvent): void {', 1)
        target.write_text(changed)
        env = {**os.environ, 'COMPONENT_FAILURE_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/component-host-failure.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('COMPONENT_FAILURE_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
