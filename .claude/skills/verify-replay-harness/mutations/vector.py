"""Exercise sequence-vector checks against broken scratch implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-harness'
cases = [
    ('prototype-collision', '\tconst positions = new Map<string, number>();\n\tfor (const event of events) {\n\t\tpositions.set(\n\t\t\tevent.streamId,\n\t\t\tMath.max(positions.get(event.streamId) ?? 0, event.seq),\n\t\t);\n\t}\n\treturn stableObject(Object.fromEntries(positions));', '\treturn stableObject(events.reduce<SeqVector>((position, event) => {\n\t\tposition[event.streamId] = Math.max(position[event.streamId] ?? 0, event.seq);\n\t\treturn position;\n\t}, {}));'),
    ('inherited-target', '\tconst limit = Object.hasOwn(targetSeq, event.streamId)\n\t\t? targetSeq[event.streamId]\n\t\t: undefined;', '\tconst limit = targetSeq[event.streamId];'),
]

for name, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-vector-mutant-') as temp:
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
        if (result.returncode == 0 or 'FAIL  test/replay/sequence-vector.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
