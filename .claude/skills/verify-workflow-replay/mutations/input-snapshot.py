"""Exercise input-boundary failures in isolated runtime copies."""
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
source = repo / 'packages/runtime'
config = repo / '.agents/skills/verify-workflow-replay/models/vitest.config.mts'
test = 'test/authoring/workflow-input-snapshot.test.ts'
cases = [
    ('start snapshot', 'src/workflow.ts', 'const input = captureWorkflowInput(args);', 'const input = args;', 3, 1),
    ('resume snapshot', 'src/workflow.ts', 'const input = captureWorkflowInput(args);', 'const input = args;', 3, 2),
    ('input validation', 'src/workflow-value.ts', 'if (!isReproducibleJsonValue(value, new Set())) throw new TypeError();', 'if (false) throw new TypeError();', 1, 0),
    ('input aliases', 'src/workflow-value.ts', 'types.isProxy(object) || seen.has(object)', 'types.isProxy(object)', 1, 0),
    ('input proxies', 'src/workflow-value.ts', 'types.isProxy(object) || seen.has(object)', 'seen.has(object)', 1, 0),
]

def occurrence_at(text, needle, index):
    start = 0
    for current in range(index + 1):
        position = text.find(needle, start)
        if position < 0:
            raise RuntimeError(f'occurrence {index} of {needle!r} not found')
        if current == index:
            return position
        start = position + len(needle)

def run(root):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test,
        '--root', str(root), '--config', str(config), '--maxWorkers=1', '--no-file-parallelism',
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

for name, relative, before, after, count, index in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-workflow-input-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / relative
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} mutation sites, found {original.count(before)}')
        position = occurrence_at(original, before, index)
        target.write_text(original[:position] + original[position:].replace(before, after, 1))
        result = run(scratch)
        if result.returncode == 0 or f'FAIL  {test} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{result.stdout}')
        print(f'Expected real-code failure: {name}', flush=True)

restored = run(source)
if restored.returncode:
    raise RuntimeError(f'restored input checks failed:\n{restored.stdout}')
print('Restored input checks passed', flush=True)
