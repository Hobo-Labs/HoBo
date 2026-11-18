"""Check real replay-order regressions in isolated runtime copies."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-ordering'
cases = [
    ('portable-order', 'src/replay/canonicalization.ts', 'return left < right ? -1 : left > right ? 1 : 0;', 'return left.localeCompare(right);'),
    ('legacy-order', 'src/replay/canonicalization.ts', 'if (version === 1) return left.localeCompare(right);', 'if (version === 1) return left < right ? -1 : left > right ? 1 : 0;'),
    ('unknown-version', 'src/replay/canonicalization.ts', 'if (value === 1 || value === 2) return value;', 'if (value === 1 || value === 2 || value === 3) return value;'),
    ('legacy-default', 'src/replay/parse.ts', 'if (version === undefined) return 1;', 'if (version === undefined) return 2;'),
    ('report-marker', 'src/replay/equivalence.ts', '\treturn Object.freeze({\n\t\tcanonicalizationVersion: version,\n\t\trunId,', '\treturn Object.freeze({\n\t\trunId,'),
    ('workflow-marker', 'src/replay/replayer.ts', 'canonicalizationVersion: digestVersion,', 'canonicalizationVersion: 2,'),
    ('divergence-marker', 'src/replay/divergence.ts', 'canonicalizationVersion: version,', 'canonicalizationVersion: 2,'),
    ('workflow-digest', 'src/replay/replayer.ts', 'stateDigest: digestForVersion(cloneAsJson(state), digestVersion)', 'stateDigest: digestForVersion(cloneAsJson(state), 2)'),
    ('event-version', 'src/replay/equivalence.ts', 'compareCanonicalEventOrder(left, right, version)', 'compareCanonicalEventOrder(left, right, 2)'),
    ('harness-divergence-version', 'src/replay/equivalence.ts', '\t\tthrow new ReplayDivergenceError({\n\t\t\tcanonicalizationVersion: version,', '\t\tthrow new ReplayDivergenceError({\n\t\t\tcanonicalizationVersion: 2,'),
    ('wire-marker', 'src/_generated/replay/replay_report_pb.ts', None, None),
]

for name, filename, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-order-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        if name == 'wire-marker':
            target.write_text((repo / skill / 'mutations/legacy-replay-report-pb.txt').read_text())
        else:
            original = target.read_text()
            if original.count(before) != 1:
                raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
            target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'REPLAY_ORDER_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/replay/ordering-version.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
