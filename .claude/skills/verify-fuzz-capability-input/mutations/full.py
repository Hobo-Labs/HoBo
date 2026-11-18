"""Exercise fuzz capability guards on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-fuzz-capability-input'
cases = [
    ('skip-add-validation', 'const captured = captureVerbs(verbs);', 'const captured = [...verbs];'),
    ('skip-attenuation-validation', 'const captured = captureVerbs(keep);', 'const captured = [...keep];'),
    ('retain-caller-array', 'const captured = [...verbs];', 'const captured = verbs;'),
    ('incorrect-event', 'verbs: captured.join(","),', 'verbs: "read",'),
    ('widen-attenuation', 'captured.filter((verb) => allowed.has(verb))', 'captured'),
    ('late-add-validation', 'const captured = captureVerbs(verbs);', ''),
    ('late-attenuation-validation', 'const captured = captureVerbs(keep);', ''),
    ('skip-array-check', 'if (!Array.isArray(verbs)) throw new Error("fuzz.invalid_verbs");', ''),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-fuzz-capability-mutant-') as temp:
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
        if name == 'late-add-validation':
            site = 'this.tick();\n\t\tthis.#capabilities.set(capabilityId, {'
            if changed.count(site) != 1:
                raise RuntimeError(f'{name}: missing insertion site')
            changed = changed.replace(site, 'this.tick();\n\t\tconst captured = captureVerbs(verbs);\n\t\tthis.#capabilities.set(capabilityId, {', 1)
        if name == 'late-attenuation-validation':
            site = 'this.tick();\n\t\tconst allowed = new Set(cap.verbs);'
            if changed.count(site) != 1:
                raise RuntimeError(f'{name}: missing insertion site')
            changed = changed.replace(site, 'this.tick();\n\t\tconst captured = captureVerbs(keep);\n\t\tconst allowed = new Set(cap.verbs);', 1)
        target.write_text(changed)
        env = {**os.environ, 'FUZZ_CAPABILITY_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/property/model-replay.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('FUZZ_CAPABILITY_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
