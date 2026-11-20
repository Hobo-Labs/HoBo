from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-connection-lifecycle'
late_guard = '''\t\tif (
\t\t\texisting.status === "revoked" &&
\t\t\t(event.type === CONNECTION_EVENTS.Authorized ||
\t\t\t\tevent.type === CONNECTION_EVENTS.HealthChanged ||
\t\t\t\tevent.type === CONNECTION_EVENTS.NeedsReauth ||
\t\t\t\tevent.type === CONNECTION_EVENTS.Rotated)
\t\t)
\t\t\treturn;'''
cases = [
    ('replay-alias', 'this.aliasIndex.has(alias) || this.byId.has(alias)', 'false || this.byId.has(alias)'),
    ('replay-alias-is-id', 'this.aliasIndex.has(alias) || this.byId.has(alias)', 'this.aliasIndex.has(alias) || false'),
    ('replay-id-is-alias', 'if (this.aliasIndex.has(id)) {', 'if (false) {'),
    ('create-alias-is-id', 'this.aliasIndex.has(input.alias) || this.byId.has(input.alias)', 'this.aliasIndex.has(input.alias) || false'),
    ('reauthorize-revoked', 'if (existing.status === "revoked") {\n\t\t\tthrow Object.assign(new Error("cannot authorize a revoked connection"), {', 'if (false) {\n\t\t\tthrow Object.assign(new Error("cannot authorize a revoked connection"), {'),
    ('late-revocation', late_guard, ''),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-connection-mutant-') as temp:
        source = repo / 'packages/identity'
        scratch = Path(temp) / 'identity'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/connection.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'IDENTITY_VERIFY_PACKAGE_ROOT': str(scratch), 'IDENTITY_VERIFY_SOURCE_ROOT': str(scratch / 'src')}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if result.returncode == 0 or 'FAIL  test/' not in output or 'AssertionError' not in output or 'Failed Suites' in output:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:8000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('IDENTITY_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass
restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
