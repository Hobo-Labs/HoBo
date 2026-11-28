"""Exercise duplicate-terminal refusal in an isolated runtime copy."""
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
source = repo / 'packages/runtime'
config = repo / '.agents/skills/verify-workflow-replay/models/vitest.config.mts'
test = 'test/authoring/workflow.test.ts'

def run(root):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test,
        '--root', str(root), '--config', str(config), '--maxWorkers=1', '--no-file-parallelism',
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

with tempfile.TemporaryDirectory(prefix='hobo-workflow-terminal-mutant-') as temp:
    scratch = Path(temp) / 'runtime'
    shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
    (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
    (scratch / 'tsconfig.json').unlink()
    target = scratch / 'src/replay/journal-history.ts'
    original = target.read_text()
    before = 'if (terminal)\n'
    if original.count(before) != 1:
        raise RuntimeError('expected one duplicate-terminal guard')
    target.write_text(original.replace(before, 'if (false)\n', 1))
    result = run(scratch)
    if result.returncode == 0 or f'FAIL  {test} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
        raise RuntimeError(f'expected a real-code assertion failure:\n{result.stdout}')
    print('Expected real-code failure: duplicate terminal guard', flush=True)

restored = run(source)
if restored.returncode:
    raise RuntimeError(f'restored terminal checks failed:\n{restored.stdout}')
print('Restored terminal checks passed', flush=True)
