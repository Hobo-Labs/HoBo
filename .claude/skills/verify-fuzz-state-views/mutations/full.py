"""Exercise fuzz state-view ownership on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-fuzz-state-views'
cap_getter = '''return new Map(
\t\t\t[...this.#capabilities].map(([id, row]) => [
\t\t\t\tid,
\t\t\t\t{ ...row, verbs: [...row.verbs] },
\t\t\t]),
\t\t);'''
cases = [
    ('live-bindle-map', 'return new Map([...this.#bindles].map(([id, row]) => [id, { ...row }]));', 'return this.#bindles;'),
    ('live-bindle-row', 'return new Map([...this.#bindles].map(([id, row]) => [id, { ...row }]));', 'return new Map([...this.#bindles].map(([id, row]) => [id, row]));'),
    ('live-capability-map', cap_getter, 'return this.#capabilities;'),
    ('live-capability-verbs', cap_getter, cap_getter.replace('verbs: [...row.verbs]', 'verbs: row.verbs')),
    ('live-resource-map', 'return new Map([...this.#resources].map(([id, row]) => [id, { ...row }]));', 'return this.#resources;'),
    ('live-resource-row', 'return new Map([...this.#resources].map(([id, row]) => [id, { ...row }]));', 'return new Map([...this.#resources].map(([id, row]) => [id, row]));'),
    ('live-checkpoints', 'return new Map(this.#snapshots);', 'return this.#snapshots;'),
    ('live-apply-result', 'return { ...resource };', 'return resource;'),
    ('live-retry-result', 'return { ...existing };', 'return existing;'),
    ('live-lookup-result', 'return resource ? { ...resource } : undefined;', 'return resource;'),
    ('public-tenant-restore', '#restoreTenant(tenantId: string, blob: SnapshotBlob): void {', 'restoreTenant(tenantId: string, blob: SnapshotBlob): void {'),
    ('interrupts-detached-result', 'const resource = this.#findByKey(tenantId, idempotencyKey);\n\t\tif (!resource) return;', 'const resource = this.findByKey(tenantId, idempotencyKey);\n\t\tif (!resource) return;'),
]

def check(case):
    name, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-fuzz-views-mutant-') as temp:
        source = repo / 'packages/fuzz'
        scratch = Path(temp) / 'fuzz'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/model.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        changed = original.replace(before, after, 1)
        if name == 'public-tenant-restore':
            site = 'this.#restoreTenant(tenantId, blob);'
            if changed.count(site) != 1:
                raise RuntimeError(f'{name}: missing call site')
            changed = changed.replace(site, 'this.restoreTenant(tenantId, blob);', 1)
        target.write_text(changed)
        env = {**os.environ, 'FUZZ_VIEWS_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/property/' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('FUZZ_VIEWS_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
