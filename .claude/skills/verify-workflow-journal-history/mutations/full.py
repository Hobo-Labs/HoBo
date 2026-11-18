"""Run the full journal-history skill against broken scratch implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-workflow-journal-history'
cases = [
    ('sequence', 'src/replay/journal-history.ts', 'event.seq !== index + 1', 'event.seq < index + 1'),
    ('event-type', 'src/replay/journal-history.ts', '!isNonEmptyPrimitiveString(event.type)', 'false'),
    ('first-start', 'src/replay/journal-history.ts', 'index === 0 && event.type !== "run.Started"', 'false'),
    ('duplicate-start', 'src/replay/journal-history.ts', 'index > 0 && event.type === "run.Started"', 'false'),
    ('terminal-order', 'src/replay/journal-history.ts', 'if (terminal)\n', 'if (false)\n'),
    ('known-current-type', 'src/replay/journal-history.ts', 'event.type.startsWith("run.") && !runtimeTypes.has(event.type)', 'false'),
    ('resume-history', 'src/workflow.ts', 'validateJournalHistory(journal);', ''),
    ('resume-current-type', 'src/workflow.ts', 'if (version === 3) validateCurrentJournalTypes(journal);', ''),
    ('replay-history', 'src/replay/replayer.ts', 'validateJournalHistory(events);', ''),
    ('replay-current-type', 'src/replay/replayer.ts', 'if (version === 3) validateCurrentJournalTypes(events);', ''),
]

for name, filename, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-journal-history-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / filename
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'WORKFLOW_HISTORY_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/authoring/workflow-journal-history.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
