"""Exercise optimizer count validation in TypeScript and CUE scratch copies."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-training-config'
cases = [
    ('count-integer', 'src/optimizer.ts', '!Number.isInteger(value)', 'false', 'code'),
    ('count-lower', 'src/optimizer.ts', 'value < 1 ||', 'false ||', 'code'),
    ('count-upper', 'src/optimizer.ts', 'value > MAX_UINT32', 'false', 'code'),
    ('iterations-path', 'src/optimizer.ts', '"config.maxIterations"', '"config.demosPerCandidate"', 'code'),
    ('demos-path', 'src/optimizer.ts', '"config.demosPerCandidate"', '"config.maxIterations"', 'code'),
    ('cue-iterations-upper', 'data-models/training_optimizer.cue', 'max_iterations?:      int & >=1 & <=4294967295', 'max_iterations?:      int & >=1', 'max_iterations'),
    ('cue-demos-upper', 'data-models/training_optimizer.cue', 'demos_per_candidate?: int & >=1 & <=4294967295', 'demos_per_candidate?: int & >=1', 'demos_per_candidate'),
]

def check(case):
    name, relative, before, after, kind = case
    with tempfile.TemporaryDirectory(prefix='hobo-training-config-mutant-') as temp:
        scratch = Path(temp) / 'training'
        source = repo / 'packages/training'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / relative
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'TRAINING_CONFIG_VERIFY_PACKAGE_ROOT': str(scratch),
               'TRAINING_CONFIG_VERIFY_CUE_PATH': str(scratch / 'data-models/training_optimizer.cue')}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        expected = ('FAIL  test/optimizer-config-bounds.test.ts >' in output and 'AssertionError' in output) if kind == 'code' else f'expected CUE rejection for {kind}=4294967296' in output
        if (result.returncode == 0 or not expected or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code or CUE assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('TRAINING_CONFIG_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
