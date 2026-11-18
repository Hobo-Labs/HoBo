"""Exercise seeded generator contracts on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-training-prng'
bound_block = '''if (!Number.isSafeInteger(bound) || bound < 1) {
\t\t\t\tthrow new RangeError("bound must be a positive safe integer");
\t\t\t}
\t\t\treturn Math.floor(next() * bound);'''
consume_block = '''const draw = next();
\t\t\tif (!Number.isSafeInteger(bound) || bound < 1) {
\t\t\t\tthrow new RangeError("bound must be a positive safe integer");
\t\t\t}
\t\t\treturn Math.floor(draw * bound);'''
cases = [
    ('seed-integer', '!Number.isInteger(seed) || ', ''),
    ('seed-min', 'seed < 0 || ', ''),
    ('seed-max', 'seed > 0xffff_ffff', 'false'),
    ('bound-integer', '!Number.isSafeInteger(bound) || ', ''),
    ('bound-min', 'bound < 1', 'false'),
    ('consume-invalid', bound_block, consume_block),
    ('state-step', 'state = (state + 0x9e3779b9) >>> 0;', 'state = state >>> 0;'),
    ('mix', 'Math.imul(z ^ (z >>> 16), 0x21f0aaad)', 'z'),
    ('scale', '/ 0x1_0000_0000', '/ 0xffff_ffff'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-training-prng-mutant-') as temp:
        scratch = Path(temp) / 'training'
        source = repo / 'packages/training'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/prng.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'TRAINING_PRNG_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/prng-contract.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('TRAINING_PRNG_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
