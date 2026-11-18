"""Check broken implementations and a restored promotion verification skill."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-promotion-verification'
cases = [
    ('verification', 'if (result.verdict !== VerificationVerdict.PASS)', 'if (false)', 'verification.property.test.ts'),
    ('promotion-binding', 'if (!sameRequest(persisted, input, intent, preview))', 'if (false)', 'request-binding.property.test.ts'),
    ('rollback-binding', 'if (reservation.meta?.rollbackRequestFingerprint !== fingerprint)', 'if (false)', 'request-binding.property.test.ts'),
    ('request-snapshot', 'const request = Object.freeze({ ...input });', 'const request = input;', 'request-binding.property.test.ts'),
    ('legacy-protocol', 'if (reservation.meta?.rollbackExecutionProtocol !== 2)', 'if (false)', 'rollback-execution.test.ts'),
    ('stored-claim', 'executionVerified =\n\t\t\t\t\tstored.length === 1 &&\n\t\t\t\t\tmatchesExecution(claimed) &&\n\t\t\t\t\tmatchesExecution(stored[0]);', 'executionVerified = matchesExecution(claimed);', 'rollback-execution.test.ts'),
    ('returned-claim', '\t\t\t\t\tmatchesExecution(claimed) &&\n', '', 'rollback-execution.test.ts'),
    ('execution-token', 'event.meta?.rollbackExecutionToken === executionToken', 'true', 'fleet-policy.test.ts'),
]


def check(case):
    name, before, after, test = case
    with tempfile.TemporaryDirectory(prefix='hobo-promotion-mutant-') as temp:
        scratch = Path(temp) / 'cd'
        source = repo / 'packages/cd'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/promotion/service.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'PROMOTION_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or f'FAIL  test/promotion/{test} >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[-6000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)


with ThreadPoolExecutor(max_workers=2) as pool:
    futures = [pool.submit(check, case) for case in cases]
    for future in as_completed(futures):
        future.result()

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
