from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_GENERATION_QUOTA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base = Path(tempfile.mkdtemp(prefix='hobo-generation-quota-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/generation-quota.ts'
original = source.read_text()
test = 'test/yard-generation-quota.test.ts'
cases = [
    ('concurrency', [('if (concurrent >= request.maxConcurrentGenerations)', 'if (false)')], 'serializes capacity'),
    ('tenant', [('if (tenant >= request.maxYardsPerTenant)', 'if (false)')], 'counts baseline and ready Yards'),
    ('baseline', [('generation_quota_baseline WHERE owner_tenant_id=?)', 'generation_quota_baseline WHERE owner_tenant_id=? AND 0)')], 'counts baseline and ready Yards'),
    ('ready-evidence', [('const verifyReady = options.verifyReady;', 'const verifyReady = () => true;')], 'serializes capacity'),
    ('ready-tenant-binding', [('claim.ownerTenantId !== request.ownerTenantId ||', 'false ||'), ('current.ownerTenantId !== request.ownerTenantId ||', 'false ||')], 'requires ready evidence to match'),
    ('retry-plan-binding', [('claim.planHash === request.planHash &&', 'true &&')], 'binds idempotent retries'),
    ('ready-yard-count', [('generation_quota_claims WHERE owner_tenant_id=?) AS count', "generation_quota_claims WHERE owner_tenant_id=? AND status='pending') AS count")], 'counts baseline and ready Yards'),
    ('persistent-database', [('!isJsonString(main?.file) || !nonblank(main.file)', 'false')], 'in-memory SQLite databases disguised'),
    ('fixed-limits', [('request.maxConcurrentGenerations !== maxConcurrentGenerations ||\n\t\t\t\trequest.maxYardsPerTenant !== maxYardsPerTenant', 'false')], 'counts baseline and ready Yards'),
    ('stored-limits', [('scopeId: options.scopeId,\n\t\tmaxConcurrentGenerations,\n\t\tmaxYardsPerTenant,\n\t\tyards: baseline,', 'scopeId: options.scopeId,\n\t\tyards: baseline,')], 'preserves claims across connections'),
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
