"""Exercise incident backfill on broken scratch implementations."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-status-page-incident'
cases = [
    ('update-marker', 'if (!prior)', 'if (false)', 2, 0),
    ('resolution-marker', 'if (!prior)', 'if (false)', 2, 1),
    ('impact-backfill', 'impact: needsImpact ? impact : existing.impact,', 'impact: existing.impact,', 1, 0),
    ('first-open-impact', 'impact: needsImpact ? impact : existing.impact,', 'impact: impact,', 1, 0),
    ('consume-marker', 'delete pending[incident.id];', '', 1, 0),
    ('marker-isolation', '...base.pendingIncidentOpens,', '', 2, 1),
    ('open-regression', 'state: mergedState,', 'state: "investigating",', 1, 0),
    ('late-state-merge', '? advanceIncidentState(existing.state, state)', '? existing.state', 1, 0),
    ('resolution-time', 'if (mergedState === "resolved" && incident.resolvedAt === undefined)\n\t\t\tincident.resolvedAt = event.ts;', '', 1, 0),
    ('update-regression', 'const state = advanceIncidentState(existing.state, nextState);', 'const state = nextState;', 1, 0),
]

def check(case):
    name, before, after, count, index = case
    with tempfile.TemporaryDirectory(prefix='hobo-status-incident-mutant-') as temp:
        scratch = Path(temp) / 'status-page'
        source = repo / 'packages/status-page'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/projection.ts'
        original = target.read_text()
        if original.count(before) != count:
            raise RuntimeError(f'{name}: expected {count} mutation sites, found {original.count(before)}')
        offset = 0
        for _ in range(index + 1):
            offset = original.index(before, offset) + len(before)
        target.write_text(original[:offset - len(before)] + after + original[offset:])
        env = {**os.environ, 'STATUS_INCIDENT_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/incident-backfill.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('STATUS_INCIDENT_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
