"""Exercise run-ID guards in isolated runtime copies."""
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
source = repo / 'packages/runtime'
config = repo / '.agents/skills/verify-workflow-replay/models/vitest.config.mts'
test = 'test/authoring/workflow-id-boundary.test.ts'
cases = [
    ('ID validator', 'src/workflow-value.ts', 'if (Object(runId) === runId || !isJsonString(runId) || runId.length === 0)', 'if (false)', 1, 0),
    ('ID object conversion', 'src/workflow-value.ts', 'if (Object(runId) === runId || !isJsonString(runId) || runId.length === 0)', 'if (!isJsonString(runId) || String(runId) !== runId || runId.length === 0)', 1, 0),
    ('start ID', 'src/workflow.ts', 'const runId = requireWorkflowRunId(\n\t\t\t\trequestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId,\n\t\t\t);', 'const runId = requestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId;', 1, 0),
    ('resume ID', 'src/workflow.ts', 'const id = requireWorkflowRunId(runId);', 'const id = runId;', 2, 0),
    ('journal ID', 'src/workflow.ts', 'const id = requireWorkflowRunId(runId);', 'const id = runId;', 2, 1),
    ('null ID default', 'src/workflow.ts', 'requestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId,', 'requestedRunId ?? `run-${randomUUID()}`,', 1, 0),
]

def run(root):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test,
        '--root', str(root), '--config', str(config), '--maxWorkers=1', '--no-file-parallelism',
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

for name, relative, before, after, count, index in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-workflow-id-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / relative
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} mutation sites, found {original.count(before)}')
        position = original.find(before) if index == 0 else original.rfind(before)
        target.write_text(original[:position] + original[position:].replace(before, after, 1))
        result = run(scratch)
        if result.returncode == 0 or f'FAIL  {test} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{result.stdout}')
        print(f'Expected real-code failure: {name}', flush=True)

restored = run(source)
if restored.returncode:
    raise RuntimeError(f'restored run-ID checks failed:\n{restored.stdout}')
print('Restored run-ID checks passed', flush=True)
