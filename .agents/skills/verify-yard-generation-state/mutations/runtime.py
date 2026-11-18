from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

repo = Path(os.environ.get('BROKER_GENERATION_STATE_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-generation-state-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
deploy = scratch / 'src/yard-placement/deploy.ts'
resolvers = scratch / 'src/yard-placement/event-store-resolvers.ts'
originals = {source: source.read_text() for source in [deploy, resolvers]}

def replace(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError(f'expected exactly one source match: {before!r}')
    return text.replace(before, after)

local_ready = '''\t\t\t\t\tyardEvent(YARD_EVENTS.Ready, {
\t\t\t\t\t\tyardId,
\t\t\t\t\t\t...(signal.payload.attemptId
\t\t\t\t\t\t\t? { attemptId: String(signal.payload.attemptId) }
\t\t\t\t\t\t\t: undefined),
\t\t\t\t\t}),'''
event_test = 'test/yard-event-store-folds.test.ts'
cases = [
    ('quote', deploy, 'request.yard.requestedYardId !== input.yardId', 'false', 'test/yard-generation-identity.test.ts', 'refuses to quote a different Yard'),
    ('plan', deploy, 'request.yard.requestedYardId !== genDecision.plan.expectedYardId', 'false', event_test, 'exact-yard-mismatch-before-generation'),
    ('yard', deploy, 'genResult.yardId !== genDecision.plan.expectedYardId', 'false', event_test, 'wrong-generated-yard-id'),
    ('attempt', deploy, 'genResult.attemptId !== genDecision.plan.attemptId', 'false', event_test, 'wrong-generation-attempt-id'),
    ('uncertainty', deploy, 'const marked = generationAttemptId ? markGenerationUncertain() : true;', 'const marked = true;', event_test, 'wrong-generated-yard-id'),
    ('warning', deploy, '`${message}${marked ? "" : "; uncertain status could not be recorded; reconcile the hold"}`', '`${message}`', event_test, 'wrong-generated-yard-uncertainty-fails'),
    ('readiness', deploy, '!readySignalMatches && genResult.status !== "ready"', 'false', event_test, 'generation-not-ready-no-signal'),
    ('raw', deploy, 'signal.payload.attemptId !== expected.attemptId ||', 'false ||', event_test, 'generation-progress-missing-attempt'),
    ('normalized-yard', deploy, 'yard.yardId !== expected.yardId ||', 'false ||', event_test, 'generation-normalizer-foreign-yard'),
    ('event-ownership', deploy, 'if (!allowed.has(type))', 'if (false && !allowed.has(type))', event_test, 'generation-normalizer-forged-placement'),
    ('snapshot', deploy, 'const data = cloneAsJson(event.data);', 'const data = event.data;', event_test, 'generation-normalizer-mutable-event'),
    ('sequence', deploy, 'data: Object.freeze(data),\n', 'data: Object.freeze(data),\n\t\t\t\t\t\tseq: event.seq,\n', event_test, 'generation-normalizer-sequence'),
    ('batch', deploy, 'pending.push(', 'append(', event_test, 'generation-unrelated-ready-signal'),
    ('ready-attempt', deploy, 'data.attemptId !== expected.attemptId', 'false', event_test, 'generation-normalizer-ready-no-attempt'),
    ('ready-status', deploy, 'type === YARD_EVENTS.StatusChanged && data.status === "ready"', 'false', event_test, 'generation-normalizer-ready-status'),
    ('ready-registration', deploy, 'yard.status === "ready"', 'false', event_test, 'generation-normalizer-ready-registration'),
    ('local-attempt', resolvers, local_ready, '\t\t\t\t\tyardEvent(YARD_EVENTS.Ready, { yardId }),', event_test, 'retains the generation attempt on a local ready signal'),
]

def run(test_file, pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run', test_file,
        '--root', str(scratch), '--config', str(config), '--maxWorkers=1',
        '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, source, before, after, test_file, pattern in cases:
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        original = originals[source]
        control = run(test_file, pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(replace(original, before, after))
        result = run(test_file, pattern)
        if result.returncode == 0 or f'FAIL  {test_file} >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
