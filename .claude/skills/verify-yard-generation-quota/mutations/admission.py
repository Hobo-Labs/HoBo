from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_GENERATION_QUOTA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base = Path(tempfile.mkdtemp(prefix='hobo-quota-admission-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/deploy.ts'
original = source.read_text()
test = 'test/yard-event-store-folds.test.ts'
cases = [
    ('durable-authority', [('if (!quota || quota.persistence !== "durable-sqlite")', 'if (!quota)'), ('quota.persistence === "durable-sqlite" &&', 'true &&')], 'generation-quota-not-durable'),
    ('bound-claim', [('!quotaClaimMatches(reservation.claim) ||', 'false ||')], 'generation-quota-claim-mismatch'),
    ('stored-ready', [('storedReady?.status !== "ready" ||', 'false ||'), ('storedReady.readyEvidenceRef !== ready.readyEvidenceRef ||', 'false ||')], 'generation-quota-ready-not-stored'),
    ('authority-replaced', [('deps.generationQuota === quota &&', 'true &&')], 'generation-quota-replaced'),
    ('authority-after-claim', [('deps.generationQuota === quota &&', 'true &&')], 'generation-quota-removed-after-claim'),
    ('policy-denied', [('(gate.effect !== "allow" && gate.effect !== "allow-degraded") ||', 'false ||')], 'generation-quota-policy-denied'),
    ('quota-order', [('\t\t\tawait admitHosting(\n\t\t\t\tgenDecision.plan.expectedYardId,', '\t\t\treserveGenerationQuota();\n\t\t\tawait admitHosting(\n\t\t\t\tgenDecision.plan.expectedYardId,')], 'generation-quota-policy-denied'),
    ('quota-reservation', [('beforeReserve();', 'undefined;')], 'funds Azure generation before provider effects: normal'),
    ('provider-boundary', [('if (generationAuthorityCurrent?.() !== true)', 'if (false)')], 'generation-quota-changed-before-provider'),
]

def run(pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test,
        '--root', str(scratch), '--config', str(config), '--maxWorkers=1',
        '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, replacements, pattern in cases:
        changed = original
        for before, after in replacements:
            if changed.count(before) != 1:
                raise RuntimeError(f'{name}: expected one match for {before!r}')
            changed = changed.replace(before, after, 1)
        control = run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(changed)
        result = run(pattern)
        if result.returncode == 0 or f'FAIL  {test} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
