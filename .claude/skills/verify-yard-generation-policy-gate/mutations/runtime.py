from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_GENERATION_POLICY_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-generation-policy-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/generation.ts'
original = source.read_text()
approval = 'if (policy.requireApproval !== false)'
effect = 'if (policy.effect !== "allow-if-no-match")'
attestation = 'if (policy.requireAttestation !== false)'
locks = 'if (\n\t\t!Array.isArray(policy.lockedProperties) ||\n\t\tpolicy.lockedProperties.length > 0\n\t)'
cases = [
    ('approval-plan', approval, 'test/yard-generation-approval.test.ts', 'refuses to plan while approval'),
    ('approval-malformed', approval, 'test/yard-generation-approval.test.ts', 'missing or malformed approval'),
    ('approval-funded', approval, 'test/yard-event-store-folds.test.ts', 'generation-approval-required'),
    ('effect-plan', effect, 'test/yard-generation-approval.test.ts', 'unknown effects and unsupported'),
    ('effect-invalid-funded', effect, 'test/yard-event-store-folds.test.ts', 'generation-invalid-effect'),
    ('effect-dedicated-funded', effect, 'test/yard-event-store-folds.test.ts', 'generation-dedicated-unsupported'),
    ('attestation-plan', attestation, 'test/yard-generation-attestation.test.ts', 'refuses generation requiring unavailable attestation'),
    ('attestation-malformed', attestation, 'test/yard-generation-attestation.test.ts', 'requires an explicit false attestation'),
    ('attestation-funded', attestation, 'test/yard-event-store-folds.test.ts', 'generation-attestation-required'),
    ('locks-plan', locks, 'test/yard-generation-attestation.test.ts', 'refuses unverified locked properties'),
    ('locks-generated', locks, 'test/yard-generation-attestation.test.ts', 'rejects generated nonempty locked-property lists'),
    ('locks-funded', locks, 'test/yard-event-store-folds.test.ts', 'generation-locked-properties'),
]

def run(test_file, pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test_file,
        '--root', str(scratch), '--config', str(config), '--maxWorkers=1',
        '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, guard, test_file, pattern in cases:
        if original.count(guard) != 1:
            raise RuntimeError(f'{name}: expected one guard')
        control = run(test_file, pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(original.replace(guard, 'if (false)', 1))
        result = run(test_file, pattern)
        if result.returncode == 0 or f'FAIL  {test_file} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
