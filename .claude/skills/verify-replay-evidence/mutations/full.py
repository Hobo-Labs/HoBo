"""Exercise replay evidence immutability against broken scratch code."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-evidence'
cases = [
    ('parsed-vector', 'src/replay/parse.ts', 'seqVector: Object.freeze([...seqVector]),', 'seqVector: [...seqVector],', 1),
    ('parsed-entry', 'src/replay/parse.ts', 'return Object.freeze({ streamId, seq });', 'return { streamId, seq };', 1),
    ('parsed-alias-entry', 'src/replay/parse.ts', 'return Object.freeze({ streamId, seq });', 'return entry;', 1),
    ('parsed-detachment', 'src/replay/parse.ts', 'return Object.freeze({ streamId, seq });', 'return Object.freeze(entry);', 1),
    ('parsed-report', 'src/replay/parse.ts', '\treturn Object.freeze({\n\t\tcanonicalizationVersion: parseCanonicalizationVersion(source),\n\t\trunId,', '\treturn Object({\n\t\tcanonicalizationVersion: parseCanonicalizationVersion(source),\n\t\trunId,', 2),
    ('parsed-orders', 'src/replay/parse.ts', 'return Object.freeze([...value]) as string[];', 'return [...value] as string[];', 1),
    ('harness-report', 'src/replay/equivalence.ts', '\treturn Object.freeze({\n\t\tcanonicalizationVersion: version,', '\treturn Object({\n\t\tcanonicalizationVersion: version,', 1),
    ('workflow-report', 'src/replay/replayer.ts', 'const report: ReplayReport = Object.freeze({', 'const report: ReplayReport = Object({', 1),
    ('produced-vector', 'src/replay/equivalence.ts', 'return Object.freeze(entries.map((entry) => Object.freeze(entry)));', 'return entries.map((entry) => Object.freeze(entry));', 1),
    ('produced-entry', 'src/replay/equivalence.ts', 'return Object.freeze(entries.map((entry) => Object.freeze(entry)));', 'return Object.freeze(entries);', 1),
    ('divergence-record', 'src/replay/divergence.ts', 'this.divergence = Object.freeze({', 'this.divergence = Object({', 1),
    ('divergence-live-order', 'src/replay/divergence.ts', 'liveOrder: Object.freeze(liveOrder),', 'liveOrder,', 1),
    ('divergence-replay-order', 'src/replay/divergence.ts', 'replayOrder: Object.freeze(replayOrder),', 'replayOrder,', 1),
    ('divergence-live-detachment', 'src/replay/divergence.ts', 'const liveOrder = [...input.liveOrder];', 'const liveOrder = input.liveOrder;', 1),
    ('divergence-replay-detachment', 'src/replay/divergence.ts', 'const replayOrder = [...input.replayOrder];', 'const replayOrder = input.replayOrder;', 1),
]

selected = os.environ.get('REPLAY_EVIDENCE_MUTANT_FILTER')
if selected:
    cases = [case for case in cases if case[0] == selected]
    if not cases:
        raise RuntimeError(f'unknown mutation: {selected}')

for name, filename, before, after, count in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-evidence-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} sites, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'REPLAY_EVIDENCE_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/replay/evidence-immutability.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
