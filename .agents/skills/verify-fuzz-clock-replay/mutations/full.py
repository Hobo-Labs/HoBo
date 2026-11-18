"""Exercise public fuzz-clock replay on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-fuzz-clock-replay'
tick_order = 'const next = this.#advanceClock();\n\t\tthis.#appendEvent("system", "clock.advanced", {});'
setter = 'set clock(value: number) {\n\t\tif (!Number.isSafeInteger(value) || value < 0 || value < this.#clock) {'
cases = [
    ('missing-tick-event', 'this.#appendEvent("system", "clock.advanced", {});', ''),
    ('missing-set-event', 'this.#appendEvent("system", "clock.set", { value: String(value) });', ''),
    ('ignore-tick-event', 'copy.tick();', ''),
    ('ignore-set-event', 'copy.clock = Number(event.payload.value);', ''),
    ('invalid-assignment', '!Number.isSafeInteger(value) ||', 'false ||'),
    ('backward-assignment', 'value < 0 || value < this.#clock', 'false'),
    ('tick-event-too-early', tick_order, 'this.#appendEvent("system", "clock.advanced", {});\n\t\tconst next = this.#advanceClock();'),
    ('set-event-too-early', setter, 'set clock(value: number) {\n\t\tthis.#appendEvent("system", "clock.set", { value: String(value) });\n\t\tif (!Number.isSafeInteger(value) || value < 0 || value < this.#clock) {'),
    ('allow-clock-tick-note', '\t"clock.advanced",\n', ''),
    ('allow-clock-set-note', '\t"clock.set",\n', ''),
    ('wrong-set-event-value', '{ value: String(value) }', '{ value: "0" }'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-fuzz-clock-replay-mutant-') as temp:
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
        if name == 'set-event-too-early':
            site = 'this.#clock = value;\n\t\tthis.#appendEvent("system", "clock.set", { value: String(value) });'
            if changed.count(site) != 1:
                raise RuntimeError(f'{name}: missing original append site')
            changed = changed.replace(site, 'this.#clock = value;', 1)
        target.write_text(changed)
        env = {**os.environ, 'FUZZ_CLOCK_REPLAY_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/property/' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('FUZZ_CLOCK_REPLAY_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
