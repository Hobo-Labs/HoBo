from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_JSON_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-json-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
matching = scratch / 'src/yard-placement/matching.ts'
types = scratch / 'src/yard-placement/types.ts'
originals = {path: path.read_text() for path in [matching, types]}

cases = [
    ('structural-match', matching, '!jsonValuesEqual(actual, value)', 'actual !== value', 1, 'matches equivalent nested JSON values'),
    ('structural-rank', matching, 'jsonValuesEqual(actual[k], v)', 'actual[k] === v', 1, 'matches equivalent nested JSON values'),
    ('special-key', types, 'return Object.freeze(Object.fromEntries(entries));', 'return Object.freeze(Object.assign({}, Object.fromEntries(entries)));', 2, 'retains special own keys'),
    ('freeze', types, 'Object.freeze(items);', '/* mutation: leave nested arrays writable */', 1, 'keeps nested array constraints immutable'),
    ('inherited', matching, 'Object.hasOwn(yard.layout.properties, key)', 'true', 1, 'treats inherited property names as absent'),
]

def run(pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        'test/yard-json-constraints.test.ts', '--root', str(scratch), '--config', str(config),
        '--maxWorkers=1', '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, source, before, after, count, pattern in cases:
        original = originals[source]
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} source matches')
        control = run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        if count == 1:
            mutant = original.replace(before, after)
        else:
            head, tail = original.rsplit(before, 1)
            mutant = head + after + tail
        source.write_text(mutant)
        result = run(pattern)
        if result.returncode == 0 or 'FAIL  test/yard-json-constraints.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
