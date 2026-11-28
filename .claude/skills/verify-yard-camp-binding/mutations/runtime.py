from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(os.environ.get('BROKER_CAMP_VERIFY_REPO', Path(__file__).resolve().parents[4]))
base = Path(tempfile.mkdtemp(prefix='hobo-camp-mutants-'))
scratch = base / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
config = Path(__file__).resolve().parents[1] / 'models/vitest.config.mts'
source = scratch / 'src/yard-placement/deploy.ts'
original = source.read_text()

def replace(before, after):
    if original.count(before) != 1:
        raise RuntimeError(f'expected exactly one source match: {before!r}')
    return original.replace(before, after)

validation = '''\tif (
\t\tvalue.envType !== undefined &&
\t\t(!isJsonString(value.envType) ||
\t\t\t!value.envType.trim() ||
\t\t\tvalue.envType.includes("/"))
\t)
\t\tthrow new TypeError("camp envType must be a nonempty path segment");
'''
quote_guard = '''\tif (selectOrGenerateCamp(request, input.yardId) === undefined)
\t\treturn {
\t\t\tcode: "camp-yard-mismatch",
\t\t\terror: "requested Camp is not a direct child of the selected Yard",
\t\t};
'''
generation_guard = '''\t\tif (
\t\t\tselectOrGenerateCamp(request, genDecision.plan.expectedYardId) ===
\t\t\tundefined
\t\t) {
\t\t\tappend(
\t\t\t\tyardEvent(YARD_EVENTS.PlacementRejected, {
\t\t\t\t\trequestId: request.requestId,
\t\t\t\t\tcode: "camp-yard-mismatch",
\t\t\t\t\treasonCodes: ["camp-yard-mismatch"],
\t\t\t\t\tmessage: "requested Camp is not a direct child of the planned Yard",
\t\t\t\t}),
\t\t\t);
\t\t\treturn rejectResult(
\t\t\t\tfoldState,
\t\t\t\temitted,
\t\t\t\t"placement",
\t\t\t\t"camp-yard-mismatch",
\t\t\t\t"requested Camp is not a direct child of the planned Yard",
\t\t\t);
\t\t}
'''
camp_test = 'test/yard-camp-binding.test.ts'
generation_test = 'test/yard-event-store-folds.test.ts'
cases = [
    ('environment', 'layout: parseCampLayout(raw.camp.layout),', 'layout: parseCampLayout(undefined),', camp_test, 'preserves the Camp layout'),
    ('parent', 'if (!campId.startsWith(prefix)) return undefined;', 'if (!campId.startsWith(prefix)) return campId;', camp_test, 'refuses a foreign or malformed'),
    ('validation', validation, '', camp_test, 'refuses malformed Camp and environment'),
    ('explicit', 'if (request.camp?.campId) {', 'if (false && request.camp?.campId) {', camp_test, 'keeps an explicit Camp'),
    ('snapshot', 'request = parseBindleDeploymentRequest(cloneAsJson(request));', '/* mutation: use caller input directly */', camp_test, 'keeps the captured environment'),
    ('quote-preflight', quote_guard, '', camp_test, 'refuses to quote a Camp outside'),
    ('generation-preflight', generation_guard, '', generation_test, 'foreign-camp-before-generation'),
    ('exact-id', 'if (raw.camp.selectionMode === "exact" && raw.camp.campId === undefined)',
     'if (false && raw.camp.selectionMode === "exact" && raw.camp.campId === undefined)',
     'test/yard-exact-camp.test.ts', 'does not authorize a default Camp'),
]

def run(test_file, pattern):
    return subprocess.run([
        'node', str(repo / 'node_modules/vitest/vitest.mjs'), 'run',
        test_file, '--root', str(scratch), '--config', str(config),
        '--maxWorkers=1', '--no-file-parallelism', '-t', pattern,
    ], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)

try:
    for name, before, after, test_file, pattern in cases:
        control = run(test_file, pattern)
        if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:
            raise RuntimeError(f'{name} control failed: {control.stdout[-5000:]}')
        print(f'Control passed: {name}', flush=True)
        source.write_text(replace(before, after))
        result = run(test_file, pattern)
        if result.returncode == 0 or f'FAIL  {test_file} >' not in result.stdout or 'Failed Suites' in result.stdout:
            raise RuntimeError(f'{name} expected assertion failure missing: {result.stdout[-5000:]}')
        print(f'Expected real-code failure: {name}', flush=True)
        source.write_text(original)
finally:
    shutil.rmtree(base)
