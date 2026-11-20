"""Exercise result-boundary failures in isolated runtime copies."""
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
source = repo / 'packages/runtime'
config = repo / '.agents/skills/verify-workflow-replay/models/vitest.config.mts'
test = 'test/authoring/workflow-result-snapshot.test.ts'
cases = [
    ('step result', 'src/workflow.ts', 'const result = captureWorkflowResult(value, name);', 'const result = value;'),
    ('workflow result', 'src/workflow.ts', 'const result = captureWorkflowResult(value);', 'const result = value;'),
    ('result validation', 'src/workflow-value.ts', 'if (!isReproducibleJsonValue(value, new Set())) throw new TypeError();', 'if (false) throw new TypeError();'),
    ('result capture', 'src/workflow-value.ts', 'const captured = cloneAsJson(value);', 'const captured = value;'),
    ('completed step replay', 'src/workflow.ts', 'if (completed && isRecord(completed.data))', 'if (false && completed && isRecord(completed.data))'),
    ('terminal replay', 'src/workflow.ts', 'if (terminal) {', 'if (false && terminal) {'),
]

def run(root):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test,
        '--root', str(root), '--config', str(config), '--maxWorkers=1', '--no-file-parallelism',
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

for name, relative, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-workflow-result-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / relative
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        result = run(scratch)
        if result.returncode == 0 or f'FAIL  {test} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{result.stdout}')
        print(f'Expected real-code failure: {name}', flush=True)

restored = run(source)
if restored.returncode:
    raise RuntimeError(f'restored result checks failed:\n{restored.stdout}')
print('Restored result checks passed', flush=True)
