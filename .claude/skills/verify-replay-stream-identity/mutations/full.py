"""Exercise replay identity and journal stream guards on broken scratch code."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-stream-identity'
cases = [
 ('primitive', 'src/workflow-boundary.ts', 'return Object(value) !== value && isJsonString(value);', 'return isJsonString(value);', 1, 0),
 ('nonempty', 'src/workflow-boundary.ts', 'return isPrimitiveString(value) && value.length > 0;', 'return isPrimitiveString(value);', 1, 0),
 ('parsed-mode', 'src/replay/parse.ts', '!isPrimitiveString(value) || !MODES.has', 'Object.prototype.toString.call(value) !== "[object String]" || !MODES.has', 1, 0),
 ('parsed-order', 'src/replay/parse.ts', 'value.some((entry) => !isPrimitiveString(entry))', 'value.some(() => false)', 1, 0),
 ('event-stream', 'src/replay/equivalence.ts', 'if (!isNonEmptyPrimitiveString(event.streamId))', 'if (false)', 2, 0),
 ('read-set-stream', 'src/replay/equivalence.ts', 'if (!isNonEmptyPrimitiveString(event.streamId))', 'if (false)', 2, 1),
 ('report-run', 'src/replay/equivalence.ts', 'if (!isNonEmptyPrimitiveString(runId))', 'if (false)', 1, 0),
 ('report-seed', 'src/replay/equivalence.ts', 'if (!isNonEmptyPrimitiveString(seed))', 'if (false)', 1, 0),
 ('target-stream', 'src/replay/equivalence.ts', 'if (!isNonEmptyPrimitiveString(streamId))', 'if (false)', 1, 0),
 ('divergence-run', 'src/replay/divergence.ts', 'if (!isNonEmptyPrimitiveString(input.runId))', 'if (false)', 1, 0),
 ('journal-stream', 'src/replay/journal-stream.ts', 'if (event.streamId !== streamId)', 'if (false)', 1, 0),
 ('journal-snapshot', 'src/replay/journal-stream.ts', 'const captured = events.map((event) => structuredClone(event));', 'const captured = [...events];', 1, 0),
 ('resume-stream', 'src/workflow.ts', 'const journal = captureJournalStream(\n\t\t\tawait store.readStream(streamId),\n\t\t\tstreamId,\n\t\t);', 'const journal = await store.readStream(streamId);', 1, 0),
 ('journal-read-stream', 'src/workflow.ts', 'const events = captureJournalStream(\n\t\t\t\tawait store.readStream(streamId),\n\t\t\t\tstreamId,\n\t\t\t);', 'const events = await store.readStream(streamId);', 1, 0),
 ('replay-stream', 'src/replay/replayer.ts', 'const events = captureJournalStream(\n\t\tawait store.readStream(streamId),\n\t\tstreamId,\n\t);', 'const events = await store.readStream(streamId);', 1, 0),
]

for name, filename, before, after, count, index in cases:
 with tempfile.TemporaryDirectory(prefix='hobo-replay-stream-mutant-') as temp:
  scratch = Path(temp) / 'runtime'
  source = repo / 'packages/runtime'
  shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
  (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
  (scratch / 'tsconfig.json').unlink()
  target = scratch / filename
  original = target.read_text()
  if original.count(before) != count:
   raise RuntimeError(f'{name}: expected {count} sites, found {original.count(before)}')
  offset = 0
  for _ in range(index + 1): offset = original.index(before, offset) + len(before)
  start = offset - len(before)
  target.write_text(original[:start] + after + original[offset:])
  env = {**os.environ, 'REPLAY_STREAM_VERIFY_PACKAGE_ROOT': str(scratch)}
  result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
  output = result.stdout
  if (result.returncode == 0 or 'FAIL  test/replay/stream-identity.test.ts >' not in output
      or 'AssertionError' not in output or 'Failed Suites' in output
      or 'Parsing or semantic analysis failed' in output):
   raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
  print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode: raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
