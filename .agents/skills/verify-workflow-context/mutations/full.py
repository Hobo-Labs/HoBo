"""Check workflow context guards and capture on broken scratch implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-workflow-context'
cases = [
    ('v3-input', 'src/workflow.ts', 'version === 3 && !hasArgs', 'false', 1, 0),
    ('v3-name', 'src/workflow.ts', 'version === 3 && recordedName === undefined', 'false', 1, 0),
    ('v3-seed', 'src/workflow.ts', 'version === 3 && recordedSeed === undefined', 'false', 1, 0),
    ('present-name', 'src/workflow.ts', '(recordedName !== undefined &&\n\t\t\t\t(!isNonEmptyPrimitiveString(recordedName) || recordedName !== def.name))', 'false', 1, 0),
    ('present-seed', 'src/workflow.ts', 'recordedSeed !== undefined && !isNonEmptyPrimitiveString(recordedSeed)', 'false', 1, 0),
    ('engine-seed', 'src/workflow.ts', 'if (!isNonEmptyPrimitiveString(seed))', 'if (false)', 1, 0),
    ('definition-name', 'src/workflow.ts', 'if (!isNonEmptyPrimitiveString(name))', 'if (false)', 2, 0),
    ('captured-name-validation', 'src/workflow.ts', 'if (!isNonEmptyPrimitiveString(name))', 'if (false)', 2, 1),
    ('callable', 'src/workflow.ts', 'Function.prototype.toString.call(run);', 'void run;', 1, 0),
    ('start-capture', 'src/workflow.ts', 'const definition = captureWorkflowDefinition(def);', 'const definition = def;', 3, 0),
    ('resume-capture', 'src/workflow.ts', 'const definition = captureWorkflowDefinition(def);', 'const definition = def;', 3, 1),
    ('adapter-capture', 'src/workflow.ts', 'const definition = captureWorkflowDefinition(def);', 'const definition = def;', 3, 2),
    ('capabilities-capture', 'src/workflow.ts', 'const capabilities = new Set(definition.capabilities);', 'const capabilities = definition.capabilities;', 1, 0),
    ('tools-capture', 'src/workflow.ts', 'const tools = Object.freeze({ ...definition.tools });', 'const tools = definition.tools;', 1, 0),
    ('run-capture', 'src/workflow.ts', 'Function.prototype.call.call(run, definition, ctx, args)', 'Function.prototype.call.call(definition.run, definition, ctx, args)', 1, 0),
    ('workflow-invocation', 'src/workflow.ts', 'Function.prototype.call.call(run, definition, ctx, args)', 'run.call(definition, ctx, args)', 1, 0),
    ('supplied-replay-seed', 'src/replay/replayer.ts', 'if (suppliedSeed !== undefined && !isNonEmptyPrimitiveString(suppliedSeed))', 'if (false)', 1, 0),
    ('recorded-replay-seed', 'src/replay/replayer.ts', 'recordedSeed !== undefined && !isNonEmptyPrimitiveString(recordedSeed)', 'false', 1, 0),
    ('replay-initial-invocation', 'src/replay/replayer.ts', 'Function.prototype.call.call(initialState, workflow, input)', 'initialState.call(workflow, input)', 1, 0),
    ('replay-execute-invocation', 'src/replay/replayer.ts', 'Function.prototype.call.call(\n\t\texecute,\n\t\tworkflow,\n\t\tctx,\n\t\tstate,\n\t\tinput,\n\t)', 'execute.call(workflow, ctx, state, input)', 1, 0),
]

for name, filename, before, after, count, index in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-workflow-context-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} sites, found {original.count(before)}')
        offset = 0
        for _ in range(index + 1):
            offset = original.index(before, offset) + len(before)
        start = offset - len(before)
        target.write_text(original[:start] + after + original[offset:])
        env = {**os.environ, 'WORKFLOW_CONTEXT_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/authoring/workflow-context-validation.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:12000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
