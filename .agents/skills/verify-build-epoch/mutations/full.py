"""Exercise build-epoch checks against deliberately broken scratch copies."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-build-epoch'
cases = [
    ('negative', 'componentize', 'src/source-date-epoch.ts', 'Number.isSafeInteger(ms) && ms >= 0', 'Number.isSafeInteger(ms)'),
    ('local-or-non-iso', 'componentize', 'src/source-date-epoch.ts', 'if (!match) return Number.NaN;', 'if (!match) return Date.parse(raw);'),
    ('calendar', 'componentize', 'src/source-date-epoch.ts', 'date.getUTCMonth() !== month - 1 ||\n\t\tdate.getUTCDate() !== day', 'false'),
    ('overflow', 'componentize', 'src/source-date-epoch.ts', 'seconds > MAX_EPOCH_SECONDS', 'false'),
    ('hour-24', 'componentize', 'src/source-date-epoch.ts', 'Number(match[4]) > 23', 'Number(match[4]) > 24'),
    ('round-up', 'componentize', 'src/source-date-epoch.ts', 'Math.floor(ms / 1000)', 'Math.ceil(ms / 1000)'),
    ('cli-independent-parser', 'cli', 'src/build/container-build.ts', '''let epochSeconds: string;
\ttry {
\t\tepochSeconds = sourceDateEpochToUnixSeconds(input.sourceDateEpoch);
\t} catch {
\t\tthrow new BuildError(
\t\t\t"HOBO_BUILD_USAGE",
\t\t\t"SOURCE_DATE_EPOCH must name supported nonnegative epoch seconds or an unambiguous ISO timestamp",
\t\t);
\t}''', '''const epochSeconds = /^\\d+$/u.test(input.sourceDateEpoch)
\t\t? Number(input.sourceDateEpoch)
\t\t: Math.floor(Date.parse(input.sourceDateEpoch) / 1000);
\tif (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0)
\t\tthrow new BuildError("HOBO_BUILD_USAGE", "invalid timestamp");'''),
]

def check(case):
    name, package, relative, before, after = case
    with tempfile.TemporaryDirectory(prefix='hobo-build-epoch-mutant-') as temp:
        roots = {}
        for name_of_package in ('componentize', 'cli'):
            source = repo / 'packages' / name_of_package
            scratch = Path(temp) / name_of_package
            shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
            (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
            (scratch / 'tsconfig.json').unlink()
            roots[name_of_package] = scratch
        target = roots[package] / relative
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'BUILD_EPOCH_COMPONENT_ROOT': str(roots['componentize']), 'BUILD_EPOCH_CLI_ROOT': str(roots['cli']), 'HOBO_TEST_MAX_WORKERS': '1'}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        output = result.stdout
        expected = 'FAIL  test/container-build.test.ts >' if package == 'cli' else 'FAIL  test/source-date-epoch.test.ts >'
        if (result.returncode == 0 or expected not in output or 'AssertionError' not in output
                or 'Failed Suites' in output or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

with ThreadPoolExecutor(max_workers=int(os.environ.get('BUILD_EPOCH_MUTATION_WORKERS', '2'))) as pool:
    for _ in pool.map(check, cases):
        pass

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=900)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
