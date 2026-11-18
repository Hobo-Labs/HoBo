"""Exercise replay protobuf validation against broken scratch code."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-protobuf'
cases = [
    ('report-wire-check', [('src/replay/proto.ts', '\tcheckReplayWire(captured, "report");', '')]),
    ('divergence-wire-check', [('src/replay/proto.ts', '\tcheckReplayWire(captured, "divergence");', '')]),
    ('oversized-varint', [('src/replay/wire.ts', 'if (index === 9 && byte > 1)', 'if (false)')]),
    ('oversized-marker', [('src/replay/wire.ts', 'if (version && value.value > 0xffffffffn)', 'if (false)')]),
    ('duplicate-marker', [('src/replay/wire.ts', 'if (sawVersion || wireType !== 0)', 'if (wireType !== 0)')]),
    ('numeric-limits', [('src/replay/proto.ts', 'if (seq > BigInt(Number.MAX_SAFE_INTEGER))', 'if (false)'), ('src/replay/parse.ts', 'if (!Number.isSafeInteger(value))', 'if (false)')]),
    ('exact-marker', [('src/replay/proto.ts', 'if (version !== undefined && !isExactKnownVersion(version))', 'if (false)')]),
    ('null-marker', [('src/replay/proto.ts', 'if (snake === null || camel === null)', 'if (false)'), ('src/replay/proto.ts', 'if (version !== undefined && !isExactKnownVersion(version))', 'if (version !== undefined && version !== null && !isExactKnownVersion(version))')]),
    ('empty-proto-json', [('src/replay/proto.ts', 'return reportFromMessage(fromJson(ReplayReportSchema, captured));', 'return parseReplayReport(captured);')]),
    ('drop-report-marker', [('src/replay/proto.ts', 'record.canonicalizationVersion = message.canonicalizationVersion;', 'void message.canonicalizationVersion;', 2, 1)]),
    ('json-report-capture', [('src/replay/proto.ts', 'const captured = captureProtoJson(raw);', 'const captured = raw;', 2, 1)]),
    ('json-divergence-capture', [('src/replay/proto.ts', 'const captured = captureProtoJson(raw);', 'const captured = raw;', 2, -1)]),
    ('binary-capture', [('src/replay/proto.ts', 'const captured = new Uint8Array(bytes);', 'const captured = bytes;', 2, 1)]),
    ('json-depth', [('src/replay/proto-json.ts', 'if (depth > 100)', 'if (false)')]),
    ('drop-positions', [('src/replay/proto.ts', '\t\tseqVector,', '\t\tseqVector: [],')]),
]

for name, edits in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-proto-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        for edit in edits:
            filename, before, after = edit[:3]
            expected = edit[3] if len(edit) > 3 else 1
            replace_count = edit[4] if len(edit) > 4 else 1
            target = scratch / filename
            original = target.read_text()
            if original.count(before) != expected:
                raise RuntimeError(f'{name}: expected {expected} sites in {filename}, found {original.count(before)}')
            if replace_count == -1:
                at = original.rfind(before)
                changed = original[:at] + original[at:].replace(before, after, 1)
            else:
                changed = original.replace(before, after, replace_count)
            target.write_text(changed)
        env = {**os.environ, 'REPLAY_PROTO_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/replay/protobuf-adapter.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
