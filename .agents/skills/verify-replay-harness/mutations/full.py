"""Run the complete replay-harness skill on broken scratch implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-replay-harness'
cases = [
    ('descriptor-precondition', 'if (\n\t\t!clockDescriptor ||\n\t\t!("value" in clockDescriptor) ||\n\t\t!randomDescriptor ||\n\t\t!("value" in randomDescriptor)\n\t)', 'if (false)'),
    ('setup-outside-cleanup', '\ttry {\n\t\tDate.now = () => now;\n\t\tclockInstalled = true;\n\t\tMath.random = () => random;\n\t\trandomInstalled = true;\n\t\treturn callback();', '\tDate.now = () => now;\n\tclockInstalled = true;\n\tMath.random = () => random;\n\trandomInstalled = true;\n\ttry {\n\t\treturn callback();'),
    ('clock-descriptor', 'Object.defineProperty(Date, "now", clockDescriptor);', 'Date.now = clockDescriptor.value;'),
    ('random-descriptor', 'Object.defineProperty(Math, "random", randomDescriptor);', 'Math.random = randomDescriptor.value;'),
    ('independent-cleanup', '\t\ttry {\n\t\t\tif (randomInstalled)\n\t\t\t\tObject.defineProperty(Math, "random", randomDescriptor);\n\t\t} finally {\n\t\t\tif (clockInstalled) Object.defineProperty(Date, "now", clockDescriptor);\n\t\t}', '\t\tif (randomInstalled) Object.defineProperty(Math, "random", randomDescriptor);\n\t\tif (clockInstalled) Object.defineProperty(Date, "now", clockDescriptor);'),
]

for name, before, after in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-replay-harness-mutant-') as temp:
        scratch = Path(temp) / 'runtime'
        source = repo / 'packages/runtime'
        shutil.copytree(source, scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
        (scratch / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
        (scratch / 'tsconfig.json').unlink()
        target = scratch / 'src/replay/equivalence.ts'
        original = target.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: expected one mutation site, found {original.count(before)}')
        target.write_text(original.replace(before, after, 1))
        env = {**os.environ, 'REPLAY_HARNESS_VERIFY_PACKAGE_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        output = result.stdout
        if (result.returncode == 0 or 'FAIL  test/replay/equivalence-cleanup.test.ts >' not in output
                or 'AssertionError' not in output or 'Failed Suites' in output
                or 'Parsing or semantic analysis failed' in output):
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{output[:10000]}\n...\n{output[-3000:]}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=600)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
