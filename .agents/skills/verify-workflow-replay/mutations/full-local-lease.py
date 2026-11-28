"""Check workflow replay and local execution fencing against broken code."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-workflow-replay'
cases = [
    ('active-claim', 'if (active.has(runId))', 'if (false && active.has(runId))', 1, 'FAIL  test/authoring/workflow-overlap.test.ts >'),
    ('pending-fence', 'if (!lease.finished || lease.pending !== 0) return;', 'if (!lease.finished) return;', 1, 'FAIL  test/authoring/workflow-overlap.test.ts >'),
    ('command-count', 'lease.pending += 1;', 'void lease.pending;', 1, 'FAIL  test/authoring/workflow-overlap.test.ts >'),
    ('release-after-setup-failure', 'lease.finished = true;', 'lease.finished = false;', 2, 'FAIL  test/authoring/workflow-overlap.test.ts >'),
    ('completed-step', 'if (treeStep.terminal?.kind === "completed") {', 'if (false && treeStep.terminal?.kind === "completed") {', 1, 'a durably journaled step must not run again on resume'),
    ('terminal-replay', 'terminal &&\n\t\t\t(terminal.type === "run.Completed" || terminal.type === "run.Failed")', 'false &&\n\t\t\t(terminal.type === "run.Completed" || terminal.type === "run.Failed")', 1, '/terminal.mts:'),
    ('id-validation', 'if (Object(runId) === runId || !isJsonString(runId) || runId.length === 0)', 'if (false)', 1, 'FAIL  test/authoring/workflow-id-boundary.test.ts >'),
    ('start-id', 'const runId = requireWorkflowRunId(\n\t\t\t\trequestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId,\n\t\t\t);', 'const runId = requestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId;', 1, 'FAIL  test/authoring/workflow-id-boundary.test.ts >'),
    ('resume-id', 'const id = requireWorkflowRunId(runId);', 'const id = runId;', 2, 'FAIL  test/authoring/workflow-id-boundary.test.ts >'),
    ('journal-id', 'const id = requireWorkflowRunId(runId);', 'const id = runId;', 2, 'FAIL  test/authoring/workflow-id-boundary.test.ts >'),
    ('null-id-default', 'requestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId,', 'requestedRunId ?? `run-${randomUUID()}`,', 1, 'FAIL  test/authoring/workflow-id-boundary.test.ts >'),
    ('start-input-snapshot', 'const input = captureWorkflowInput(args);', 'const input = args;', 2, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('resume-input-snapshot', 'const input = captureWorkflowInput(args);', 'const input = args;', 2, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-shape', 'if (!isReproducibleJsonValue(value, new Set()))', 'if (false)', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-aliases', 'types.isProxy(object) || seen.has(object)', 'types.isProxy(object)', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-proxies', 'types.isProxy(object) || seen.has(object)', 'seen.has(object)', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-hidden', '!descriptor.enumerable ||\n\t\t\t!descriptor.writable ||\n\t\t\t!descriptor.configurable', '!descriptor.writable ||\n\t\t\t!descriptor.configurable', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-readonly', '!descriptor.enumerable ||\n\t\t\t!descriptor.writable ||\n\t\t\t!descriptor.configurable', '!descriptor.enumerable ||\n\t\t\t!descriptor.configurable', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-configurable', '!descriptor.enumerable ||\n\t\t\t!descriptor.writable ||\n\t\t\t!descriptor.configurable', '!descriptor.enumerable ||\n\t\t\t!descriptor.writable', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-extensible', '!Object.isExtensible(object) ||', 'false ||', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
    ('input-symbols', 'Object.getOwnPropertySymbols(object).length !== 0', 'false', 1, 'FAIL  test/authoring/workflow-input-snapshot.test.ts >'),
]


def check(case):
    name, before, after, count, expected = case
    with tempfile.TemporaryDirectory(prefix='hobo-workflow-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        runtimes = Path(temp) / 'runtimes'
        runtimes.mkdir()
        (runtimes / 'runtime-local').symlink_to(repo / 'packages/runtimes/runtime-local', target_is_directory=True)
        boundary_cases = {'id-validation', 'input-shape', 'input-aliases', 'input-proxies', 'input-hidden', 'input-readonly', 'input-configurable', 'input-extensible', 'input-symbols'}
        target = scratch / ('src/workflow-value.ts' if name in boundary_cases else 'src/workflow.ts')
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} mutation sites, found {original.count(before)}')
        if name in {'journal-id', 'resume-input-snapshot'}:
            position = original.rfind(before)
            changed = original[:position] + original[position:].replace(before, after, 1)
        else:
            changed = original.replace(before, after, 1 if name in {'release-after-setup-failure', 'resume-id', 'start-input-snapshot'} else count)
        target.write_text(changed)
        env = {**os.environ, 'WORKFLOW_VERIFY_PACKAGE_ROOT': str(scratch), 'WORKFLOW_VERIFY_SOURCE': str(scratch / 'src/workflow.ts')}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or expected not in output or 'AssertionError' not in output
                or 'Failed Suites' in output or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:12000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)


with ThreadPoolExecutor(max_workers=int(os.environ.get('WORKFLOW_MUTATION_WORKERS', '2'))) as pool:
    futures = [pool.submit(check, case) for case in cases]
    for future in as_completed(futures):
        future.result()

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
