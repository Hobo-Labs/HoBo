"""Exercise replay binding against deliberately broken scratch code."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-workflow-replay'
cases = [
    ('run-id', 'const id = requireWorkflowRunId(runId);', 'const id = runId;'),
    ('input-snapshot', 'const input = captureWorkflowInput(args);', 'const input = args;'),
    ('input-match', '!isDeepStrictEqual(started.data.args, input)', 'false'),
    ('name-match', 'recordedName !== undefined && recordedName !== workflowName', 'false'),
    ('name-present', 'version === 3 && recordedName === undefined', 'false'),
    ('name-snapshot', 'recordedName !== workflowName', 'recordedName !== workflow.name'),
    ('seed-match', 'suppliedSeed !== undefined &&\n\t\t\trecordedSeed !== undefined &&\n\t\t\tsuppliedSeed !== recordedSeed', 'false'),
    ('seed-present', 'version === 3 && recordedSeed === undefined', 'false'),
    ('seed-valid', 'recordedSeed !== undefined &&\n\t\t\t(!isJsonString(recordedSeed) || String(recordedSeed) !== recordedSeed)', 'false'),
    ('initial-callback', 'initialState.call(workflow, input)', 'workflow.initialState(input)'),
    ('execute-callback', 'execute.call(workflow, ctx, state, input)', 'workflow.execute(ctx, state, input)'),
    ('seed-snapshot', 'const suppliedSeed = options.seed;', 'let suppliedSeed = options.seed;'),
]


def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-replay-binding-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        runtimes = Path(temp) / 'runtimes'
        runtimes.mkdir()
        (runtimes / 'runtime-local').symlink_to(repo / 'packages/runtimes/runtime-local', target_is_directory=True)
        target = scratch / 'src/replay/replayer.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        changed = original.replace(before, after, 1)
        if name == 'seed-snapshot':
            read = 'const events = await store.readStream(streamId);'
            if changed.count(read) != 1:
                raise RuntimeError('seed-snapshot: expected one read site')
            changed = changed.replace(read, read + '\n\tsuppliedSeed = options.seed;', 1)
        target.write_text(changed)
        env = {**os.environ, 'WORKFLOW_VERIFY_PACKAGE_ROOT': str(scratch), 'WORKFLOW_VERIFY_SOURCE': str(scratch / 'src/workflow.ts')}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        expected = 'FAIL  test/replay/replay-binding.test.ts >'
        if (result.returncode == 0 or expected not in output or 'AssertionError' not in output
                or 'Failed Suites' in output or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:12000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)


with ThreadPoolExecutor(max_workers=int(os.environ.get('WORKFLOW_REPLAY_BINDING_MUTATION_WORKERS', '2'))) as pool:
    futures = [pool.submit(check, case) for case in cases]
    for future in as_completed(futures):
        future.result()

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
