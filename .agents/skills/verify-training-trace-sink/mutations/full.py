"""Exercise trace snapshots and draining on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-training-trace-sink'
push_block = '''spans.push(
\t\t\t\tObject.freeze({
\t\t\t\t\t...span,
\t\t\t\t\tattributes: Object.freeze({ ...span.attributes }),
\t\t\t\t}),
\t\t\t);'''
unfrozen_block = '''spans.push({
\t\t\t\t...span,
\t\t\t\tattributes: Object.freeze({ ...span.attributes }),
\t\t\t});'''
cases = [
    ('span-copy', push_block, 'spans.push(span);'),
    ('span-freeze', push_block, unfrozen_block),
    ('attributes-copy', 'Object.freeze({ ...span.attributes })', 'span.attributes'),
    ('attributes-freeze', 'Object.freeze({ ...span.attributes })', '{ ...span.attributes }'),
    ('drain-reset', 'spans = [];', ''),
    ('drain-freeze', 'return Object.freeze(drained);', 'return drained;'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-training-trace-mutant-') as temp:
        scratch = Path(temp) / 'training'
        source = repo / 'packages/training'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/trace-sink.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'TRAINING_TRACE_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/trace-sink-snapshots.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('TRAINING_TRACE_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
