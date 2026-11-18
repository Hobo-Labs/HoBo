"""Exercise trace-batch commit ordering on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-training-trace-commit'
cases = [
    ('eager-record', 'traceBatch.push(', 'sink.record('),
    ('skip-commit', 'for (const span of traceBatch) sink.record(span);', ''),
    ('drop-previous', 'for (const span of traceBatch) sink.record(span);', 'sink.drain();\n\t\tfor (const span of traceBatch) sink.record(span);'),
    ('commit-before-validation', 'const candidate = parseTrainingCandidate({', 'for (const span of traceBatch) sink.record(span);\n\t\tconst candidate = parseTrainingCandidate({'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-training-trace-commit-mutant-') as temp:
        scratch = Path(temp) / 'training'
        source = repo / 'packages/training'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/optimizer.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        changed = original.replace(before, after, 1)
        if name == 'commit-before-validation':
            final = 'for (const span of traceBatch) sink.record(span);\n\t\treturn candidate;'
            if changed.count(final) != 1:
                raise RuntimeError('commit-before-validation: expected final batch commit')
            changed = changed.replace(final, 'return candidate;', 1)
        target.write_text(changed)
        env = {**os.environ, 'TRAINING_TRACE_COMMIT_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/optimizer-selection.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('TRAINING_TRACE_COMMIT_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
