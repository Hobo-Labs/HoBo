"""Run the verification skill against broken scratch bootstrap implementations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
skill = '.agents/skills/verify-dev-bootstrap'
cases = [
    ('override selection', [('if [[ -f "$MISE_INSTALL_PATH" && -x "$MISE_INSTALL_PATH" ]]; then', 'if command -v mise >/dev/null 2>&1; then')]),
    ('relative path', [('if [[ "$MISE_INSTALL_PATH" != /* ]]; then', 'if false; then'), ('if [[ "$install_path" != /* ]]; then', 'if false; then')]),
    ('installer failure', [('mise_ensure_installed || return $?', 'mise_ensure_installed')]),
    ('missing executable', [('if [[ ! -f "$install_path" || ! -x "$install_path" ]]; then', 'if false; then')]),
    ('existing executable', [('if [[ -f "$MISE_INSTALL_PATH" && -x "$MISE_INSTALL_PATH" ]]; then', 'if false; then')]),
]

def make_scratch(root):
    (root / 'scripts/test').mkdir(parents=True)
    (root / 'tools').mkdir()
    shutil.copytree(repo / 'scripts/lib', root / 'scripts/lib')
    shutil.copytree(repo / 'scripts/test/support', root / 'scripts/test/support')
    shutil.copytree(repo / 'tools/pins', root / 'tools/pins')
    for relative in ['scripts/bootstrap-dev.sh', 'scripts/test/dev-env-bootstrap.test.ts', 'scripts/test/mise-install-retry.test.ts', 'mise.toml', 'mise.lock', 'AGENTS.md', 'CLAUDE.md']:
        shutil.copy2(repo / relative, root / relative)

for name, replacements in cases:
    with tempfile.TemporaryDirectory(prefix='hobo-dev-bootstrap-mutant-') as temp:
        scratch = Path(temp) / 'repo'
        make_scratch(scratch)
        target = scratch / 'scripts/lib/mise-path.sh'
        changed = target.read_text()
        for before, after in replacements:
            if changed.count(before) != 1:
                raise RuntimeError(f'{name}: expected one mutation site, found {changed.count(before)}')
            changed = changed.replace(before, after, 1)
        target.write_text(changed)
        env = {**os.environ, 'HOBO_BOOTSTRAP_VERIFY_ROOT': str(scratch)}
        result = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
        if result.returncode == 0 or 'AssertionError' not in result.stdout or 'Model checking completed. No error has been found.' not in result.stdout or 'ERR_MODULE_NOT_FOUND' in result.stdout:
            raise RuntimeError(f'{name}: expected a real-code assertion failure:\n{result.stdout}')
        print(f'Expected full-skill real-code failure: {name}', flush=True)

restored = subprocess.run(['bash', 'scripts/verify-state-machine.sh', skill], cwd=repo, timeout=180)
if restored.returncode:
    raise SystemExit(f'restored skill failed: {restored.returncode}')
print('Restored full skill passed', flush=True)
