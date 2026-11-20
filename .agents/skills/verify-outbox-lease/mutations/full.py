from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-outbox-lease'
cases = [
    ('queue-attempt', 'AND lease_id = ? AND lease_fence = ? AND delivery_attempt = ?', 'AND lease_id = ? AND lease_fence = ?', '.run(now, messageId, leaseId, leaseFence, deliveryAttempt);', '.run(now, messageId, leaseId, leaseFence);'),
    ('outbox-attempt', 'AND lease_id = ? AND lease_fence = ? AND attempt_count = ?', 'AND lease_id = ? AND lease_fence = ?', '.run(now, outboxId, leaseId, leaseFence, deliveryAttempt);', '.run(now, outboxId, leaseId, leaseFence);'),
]
for name, sql, weaker_sql, args, weaker_args in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-delivery-lease-mutant-') as temp:
        source = repo / 'packages/storage-sqlite'
        scratch = Path(temp) / 'storage-sqlite'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/journal.ts'
        original = target.read_text()
        if original.count(sql) != 1 or original.count(args) != 1:
            raise RuntimeError(f'{name}: mutation sites are not unique')
        target.write_text(original.replace(sql, weaker_sql, 1).replace(args, weaker_args, 1))
        env = {**os.environ, 'STORAGE_VERIFY_PACKAGE_ROOT': str(scratch), 'STORAGE_VERIFY_SOURCE_ROOT': str(scratch / 'src')}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if result.returncode == 0 or 'FAIL  test/' not in output or 'AssertionError' not in output or 'Failed Suites' in output:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:8000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)
restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
