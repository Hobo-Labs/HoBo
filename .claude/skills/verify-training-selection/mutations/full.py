"""Exercise reward validation and winner selection on broken scratch code."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-training-selection'
premature = '''sink.record({ id: "premature", parentId: "", kind: "CHAIN", name: "premature", inputDigest: "sha256:premature", score: 0, decision: "kept", attributes: {} });
\t\tconst pool = demoPool(request.trajectories);'''
cases = [
    ('reward-finite', '!Number.isFinite(reward.score)', 'false'),
    ('reward-lower', 'reward.score < 0', 'false'),
    ('reward-upper', 'reward.score > 1', 'false'),
    ('trace-before-validation', 'const pool = demoPool(request.trajectories);', premature),
    ('strict-ties', 'proposal.score > best.score', 'proposal.score >= best.score'),
    ('keep-best', 'best === undefined || proposal.score > best.score', 'true'),
    ('winner-digest', 'winnerDigest: winner.digest,', 'winnerDigest: "",'),
    ('winner-score', 'winnerScore: winner.score,', 'winnerScore: -1,'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-training-selection-mutant-') as temp:
        scratch = Path(temp) / 'training'
        source = repo / 'packages/training'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/optimizer.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'TRAINING_SELECTION_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/optimizer-selection.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('TRAINING_SELECTION_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
