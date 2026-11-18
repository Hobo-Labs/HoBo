"""Exercise fuzz event-history guarantees on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-fuzz-event-history'
view = '''return this.#eventLog.map((event) => ({
\t\t\t...event,
\t\t\tpayload: { ...event.payload },
\t\t}));'''
cases = [
    ('append-without-tick', 'this.note(tenantId, kind, payload);', 'this.#appendEvent(tenantId, kind, payload);'),
    ('accept-owned-kind', 'REPLAY_OWNED_EVENT_KINDS.has(kind)', 'false'),
    ('retain-input-payload', 'const captured = captureEventPayload(payload);', 'const captured = payload;'),
    ('return-live-history', view, 'return this.#eventLog;'),
    ('return-live-payload', 'payload: { ...event.payload },', 'payload: event.payload,'),
    ('accept-nonstring-payload', '''!Object.values(captured).every(
\t\t\t(value) => value?.constructor === String && Object(value) !== value,
\t\t)''', 'false'),
    ('skip-object-check', '!payload || Object(payload) !== payload || Array.isArray(payload)', 'false'),
    ('late-payload-validation', 'const captured = captureEventPayload(payload);\n\t\tthis.#advanceClock();', 'this.#advanceClock();\n\t\tconst captured = captureEventPayload(payload);'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-fuzz-event-mutant-') as temp:
        source = repo / 'packages/fuzz'
        scratch = Path(temp) / 'fuzz'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/model.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        changed = original.replace(before, after, 1)
        if name == 'retain-input-payload':
            second = 'payload: { ...payload },'
            if changed.count(second) != 1:
                raise RuntimeError(f'{name}: missing storage copy')
            changed = changed.replace(second, 'payload,', 1)
        target.write_text(changed)
        env = {**os.environ, 'FUZZ_EVENT_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/property/model-replay.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('FUZZ_EVENT_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
