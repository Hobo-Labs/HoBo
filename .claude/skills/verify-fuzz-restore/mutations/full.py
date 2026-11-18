"""Exercise fuzz restore and replay on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-fuzz-restore'
cases = [
    ('missing-baseline', 'if (pristine) this.replayBaseline = raw;', 'if (pristine) {}'),
    ('ignore-baseline', 'if (this.replayBaseline !== undefined) copy.restore(this.replayBaseline);', ''),
    ('missing-restore-event', 'else this.#appendEvent("system", "model.restored", { snapshot: raw });', 'else {}'),
    ('ignore-restore-event', 'copy.restore(event.payload.snapshot ?? "");', 'copy.note(event.tenantId, "ignored.restore", { ...event.payload });'),
    ('reuse-replacement-clock', 'this.clock = pristine ? blob.clock : baseClock + 1;', 'this.clock = pristine ? blob.clock : baseClock;'),
    ('skip-fingerprint', 'candidate.fingerprint() !== blob.fingerprint', 'false'),
    ('accept-duplicate-ids', 'row.id !== id || seen.has(id)', 'row.id !== id'),
    ('accept-mismatched-id', 'row.id !== id || seen.has(id)', 'seen.has(id)'),
    ('accept-unknown-verb', '!row.verbs.every(isVerb)', 'false'),
    ('accept-unknown-status', '!isResourceStatus(row.status)', 'false'),
    ('ignore-clock-limit', 'baseClock >= Number.MAX_SAFE_INTEGER', 'false'),
    ('partial-before-parse', 'const blob = parseSnapshot(raw);', 'this.clock = 0;\n\t\tconst blob = parseSnapshot(raw);'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-fuzz-restore-mutant-') as temp:
        source = repo / 'packages/fuzz'
        scratch = Path(temp) / 'fuzz'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/model.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'FUZZ_RESTORE_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/property/model-replay.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('FUZZ_RESTORE_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
