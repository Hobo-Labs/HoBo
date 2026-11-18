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

cases = [
    ('unknown', 'if (!Buffer.from(withUnknown).equals(Buffer.from(withoutUnknown)))', 'if (false && !Buffer.from(withUnknown).equals(Buffer.from(withoutUnknown)))', 'refuses unknown root'),
    ('version', 'if (message.workBindingVersion !== WORK_BINDING_VERSION)', 'if (false && message.workBindingVersion !== WORK_BINDING_VERSION)', 'refuses a complete request with an unsupported version'),
    ('amount', 'message.spendEstimateUsd < 0', 'false', 'refuses a negative estimate even'),
    ('tenant', '!message.ownerTenantId || !message.objective || !message.yard.requestId', '!message.objective || !message.yard.requestId', 'refuses an empty tenant'),
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
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected exactly one source match')
        control = run(pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(original.replace(before, after))
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
finally:
    shutil.rmtree(base)
