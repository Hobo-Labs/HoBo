"""Run replay sequence-boundary checks on broken scratch implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-harness'
cases = [
    ('event-guard', 'src/replay/equivalence.ts', 'if (!Number.isSafeInteger(event.seq) || event.seq < 0)', 'if (false)'),
    ('target-guard', 'src/replay/equivalence.ts', 'if (!Number.isSafeInteger(sequence) || sequence < 0)', 'if (false)'),
    ('parse-guard', 'src/replay/parse.ts', 'if (!Number.isSafeInteger(value))', 'if (false)'),
    ('explicit-event-validation', 'src/replay/equivalence.ts', 'const defaultTarget = seqVector(capturedEvents);', 'const defaultTarget = targetSeq === undefined ? seqVector(capturedEvents) : {};'),
    ('replay-before-callback', 'src/replay/replayer.ts', 'const recordedVector = seqVector(events);', ''),
]

for name, filename, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-safe-seq-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        changed = original.replace(before, after, 1)
        if name == 'replay-before-callback':
            marker = 'const report: ReplayReport = {'
            if changed.count(marker) != 1:
                raise RuntimeError('replay-before-callback: expected report site')
            changed = changed.replace(marker, 'const recordedVector = seqVector(events);\n\t' + marker, 1)
        target.write_text(changed)
        env = {**os.environ, 'REPLAY_HARNESS_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/replay/sequence-safety.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
