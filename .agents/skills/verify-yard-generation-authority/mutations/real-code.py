"""Replay generation-authority mutations against real broker tests."""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = Path(__file__).resolve().parents[1]
original = repo / 'packages/broker/src/yard-placement/deploy.ts'
scratch_parent = Path(tempfile.mkdtemp(prefix='hobo-yard-generation-mutants-'))
scratch = scratch_parent / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
target = scratch / 'src/yard-placement/deploy.ts'
config = skill / 'models/vitest.config.mts'

def remove_checks(s, pairs):
    for needle, replacement, count in pairs:
        if s.count(needle) != count:
            raise Exception(f'expected {count} occurrences of {needle!r}, found {s.count(needle)}')
        s = s.replace(needle, replacement)
    return s

def pair(unequal, equal, equals):
    return lambda s: remove_checks(s, [(unequal, 'false', 1), (equal, 'true', equals)])

def pin(s):
    pattern = r'const saga = createYardGenerationSaga\(\{\s*connectors: new Map\(\[\s*\[genDecision.plan.generatorConnectorId, pinnedConnector\],\s*\]\),\s*\}\);'
    s, n = re.subn(pattern, 'const saga = createYardGenerationSaga({ connectors });', s)
    if n != 1: raise Exception('connector pin not found')
    return s

def claim(s):
    pattern = r'if \(!paidContextCurrent\(\) \|\| !generationAuthorityCurrent\(\)\)\s*throw new Error\(\s*"hosting context changed before generation claim; reconcile reservation",\s*\);'
    matches = list(re.finditer(pattern, s))
    if len(matches) != 2: raise Exception('claim fences not found')
    match = matches[-1]
    return s[:match.start()] + s[match.end():]

def effect(s):
    pattern = r'if \(!generationAuthorityCurrent\(\)\)\s*throw new Error\(\s*"generation authority changed before provider operation",\s*\);'
    s, n = re.subn(pattern, '', s)
    if n != 1: raise Exception('provider fence not found')
    return s

def receipt(s):
    pattern = r'if \(generationAuthorityCurrent && !generationAuthorityCurrent\(\)\)\s*throw new Error\("generation authority changed before receipt"\);'
    s, n = re.subn(pattern, '', s)
    if n != 1: raise Exception('receipt fence not found')
    return s

def initial_read(s):
    pattern = r'catch \(error\) \{\s*return rejectResult\(\s*foldState,\s*emitted,\s*"placement",\s*"yard-runtime-catalog-unavailable",[\s\S]*?\);\s*\}'
    s, n = re.subn(pattern, 'catch (error) { throw error; }', s, count=1)
    if n != 1: raise Exception('runtime snapshot refusal not found')
    return s

cases = [
    ('policy-content', pair('contentHashOf(generationPolicy) !== generationPolicyDigest','contentHashOf(generationPolicy) === generationPolicyDigest',2), 'generation-policy-revoked'),
    ('policy-identity', pair('deps.generationPolicy !== generationPolicyInput','deps.generationPolicy === generationPolicyInput',2), 'generation-policy-replaced'),
    ('runtime-content', pair('contentHashOf(runtimeCatalog.snapshot()) !== runtimeSnapshotDigest','contentHashOf(runtimeCatalog.snapshot()) === runtimeSnapshotDigest',1), 'generation-runtime-revoked'),
    ('runtime-identity', pair('deps.runtimeCatalog !== runtimeCatalogInput','deps.runtimeCatalog === runtimeCatalogInput',2), 'generation-runtime-catalog-replaced'),
    ('runtime-method', pair('runtimeCatalog.snapshot !== runtimeSnapshotMethod','runtimeCatalog.snapshot === runtimeSnapshotMethod',1), 'generation-snapshot-method-replaced'),
    ('registry-identity', pair('deps.connectors !== connectorsInput','deps.connectors === connectorsInput',2), 'generation-registry-replaced'),
    ('registry-method', pair('connectors.get !== connectorLookup','connectors.get === connectorLookup',1), 'generation-lookup-method-replaced'),
    ('connector-identity', lambda s: remove_checks(s,[('nowConnector === selectedConnector','true',1)]), 'generation-connector-replaced'),
    ('connector-method', lambda s: remove_checks(s,[('nowConnector.provision === selectedProvision','true',1),('selectedConnector.provision === selectedProvision','true',1)]), 'generation-method-replaced'),
    ('connector-pin', pin, 'generation-lookup-redirect'),
    ('claim-fence', claim, 'generation-policy-before-claim'),
    ('effect-fence', effect, 'generation-runtime-after-claim'),
    ('receipt-fence', receipt, 'generation-policy-before-receipt'),
    ('initial-snapshot', initial_read, 'generation-runtime-read-initial'),
]

def run(pattern):
    args = ['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/yard-event-store-folds.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern]
    return subprocess.run(args,cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)

try:
    control = run('generation-policy-revoked')
    if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
        raise Exception(f'unmodified control failed:\n{control.stdout[-2500:]}')
    print('Unmodified control passed',flush=True)
    for name, mutate, pattern in cases:
        target.write_text(mutate(original.read_text()))
        result = run(pattern)
        if result.returncode == 0 or 'FAIL  test/yard-event-store-folds.test.ts >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise Exception(f'{name} did not fail the expected running test ({result.returncode}):\n{result.stdout[-2500:]}')
        print(f'Expected real-code failure: {name}',flush=True)
finally:
    shutil.rmtree(scratch_parent)
