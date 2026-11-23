"""Exercise replay input snapshots against broken scratch implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-harness'
cases = [
    ('event-capture', 'const capturedEvents = events.map((event) => clone(event));', 'const capturedEvents = events;'),
    ('read-set', 'readSetHash: hashReadSet(capturedEvents)', 'readSetHash: hashReadSet(events)'),
    ('target-capture', 'const capturedTarget = Object.fromEntries(\n\t\tObject.getOwnPropertyNames(requestedTarget).map((streamId) => {\n\t\t\tif (!isNonEmptyPrimitiveString(streamId))\n\t\t\t\tthrow new TypeError("target stream must be a non-empty string");\n\t\t\tconst sequence = must(\n\t\t\t\trequestedTarget[streamId],\n\t\t\t\t`target sequence for ${streamId}`,\n\t\t\t);\n\t\t\tif (!Number.isSafeInteger(sequence) || sequence < 0)\n\t\t\t\tthrow new RangeError(\n\t\t\t\t\t"target sequence must be a non-negative safe integer",\n\t\t\t\t);\n\t\t\treturn [streamId, sequence];\n\t\t}),\n\t);', 'const capturedTarget = requestedTarget;'),
    ('target-hidden', 'Object.getOwnPropertyNames(requestedTarget)', 'Object.keys(requestedTarget)'),
    ('target-selection', 'isAtOrBefore(event, capturedTarget)', 'isAtOrBefore(event, requestedTarget)'),
    ('target-report', 'seqVector: toSeqVectorEntries(capturedTarget)', 'seqVector: toSeqVectorEntries(requestedTarget)'),
]

for name, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-snapshot-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/replay/equivalence.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'REPLAY_HARNESS_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/replay/target-snapshot.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
