from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_WIRE_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-wire-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/wire.ts'
original = source.read_text()
parser = scratch / 'src/yard-placement/deploy.ts'
parser_original = parser.read_text()
schema = scratch / 'data-models/yard_placement.cue'
schema_original = schema.read_text()
nonblank = [line for line in schema_original.splitlines(keepends=True) if line.startswith('#CampNonblank:')]
if len(nonblank) != 1:
    raise RuntimeError('expected one Camp nonblank constraint')
yard_nonblank = [line for line in schema_original.splitlines(keepends=True) if line.startswith('#YardIdNonblank:')]
if len(yard_nonblank) != 1:
    raise RuntimeError('expected one Yard ID nonblank constraint')

cases = [
    ('unknown', 'if (!Buffer.from(withUnknown).equals(Buffer.from(withoutUnknown)))', 'if (false && !Buffer.from(withUnknown).equals(Buffer.from(withoutUnknown)))', 'refuses unknown root'),
    ('amount', 'message.spendEstimateUsd < 0', 'false', 'refuses a negative estimate even'),
    ('tenant', '!message.ownerTenantId || !message.objective || !message.yard.requestId', '!message.objective || !message.yard.requestId', 'refuses an empty tenant'),
    ('duplicate-labels', 'if (seen.has(entry.key)) throw new TypeError("duplicate placement label");', '', 'rejects incomplete or ambiguous value encodings'),
    ('property-text', '!isJsonObject(properties) ||\n\t\tJSON.stringify(properties) !== yardLayout.propertiesJson', '!isJsonObject(properties)', 'rejects incomplete or ambiguous value encodings'),
    ('residency', '\t\t\t\tparseYardResidencyTag(entry);', '\t\t\t\t/* omit preflight */', 'refuses invalid residency even when the digest matches'),
    ('camp-exact-decoder', 'if (raw.camp.selectionMode === "exact" && raw.camp.campId === undefined)', 'if (false && raw.camp.selectionMode === "exact" && raw.camp.campId === undefined)', 'refuses an exact Camp without an ID even when'),
    ('camp-exact-cue', '\tif selection_mode == "exact" {\n\t\tcamp_id!: #CampNonblank\n\t}\n', '', 'Yard request CUE contract.*refuses an exact Camp without an ID'),
    ('camp-blank-cue', nonblank[0], '#CampNonblank: string\n', 'agrees with Camp parser nonblank'),
    ('yard-exact-decoder', 'yardRaw.selectionMode === "exact" &&\n\t\tyardRaw.requestedYardId === undefined', 'false && yardRaw.requestedYardId === undefined', 'refuses an exact Yard without an ID even when'),
    ('yard-blank-decoder', '!yardRaw.requestedYardId.trim()', 'false', 'agrees with the parser on Yard ID presence'),
    ('yard-exact-cue', '\tif selection_mode == "exact" {\n\t\trequested_yard_id!: #YardIdNonblank\n\t}\n', '', 'Yard request CUE contract.*refuses an exact Yard without an ID'),
    ('yard-blank-cue', yard_nonblank[0], '#YardIdNonblank: string\n', 'agrees with the parser on Yard ID presence'),
    ('canonical', 'digest !== contentHashOf(raw) || digest !== message.requestDigest', 'digest !== message.requestDigest', 'refuses noncanonical wire fields'),
    ('digest', 'digest !== contentHashOf(raw) || digest !== message.requestDigest', 'digest !== contentHashOf(raw)', 'refuses old, incomplete'),
]

def run(pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        'test/yard-request-wire.test.ts', '--root', str(scratch), '--config', str(config),
        '--maxWorkers=1', '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, before, after, pattern in cases:
        target = parser if name in {'residency', 'camp-exact-decoder', 'yard-exact-decoder', 'yard-blank-decoder'} else schema if name in {'camp-exact-cue', 'camp-blank-cue', 'yard-exact-cue', 'yard-blank-cue'} else source
        target_original = parser_original if target == parser else schema_original if target == schema else original
        if target_original.count(before) != 1:
            raise RuntimeError(f'{name}: expected exactly one source match')
        control = run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        target.write_text(target_original.replace(before, after))
        if name == 'amount':
            redundant = run(pattern)
            if redundant.returncode != 0 or 'Test Files  1 passed' not in redundant.stdout:
                raise RuntimeError(f'parser amount guard failed: {redundant.stdout[-5000:]}')
            print('Parser guard independently rejects negative amounts', flush=True)
            if parser_original.count('raw.spendEstimateUsd < 0') != 1:
                raise RuntimeError('expected exactly one parser amount guard')
            parser.write_text(parser_original.replace('raw.spendEstimateUsd < 0', 'false'))
        result = run(pattern)
        if result.returncode == 0 or 'FAIL  test/yard-request-wire.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
        parser.write_text(parser_original)
        schema.write_text(schema_original)
finally:
    shutil.rmtree(base)
