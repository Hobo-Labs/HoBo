import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const requireRuntime = createRequire(path.resolve('packages/runtime/package.json'));
const fc = requireRuntime('fast-check');
const root = process.env.HOBO_BOOTSTRAP_VERIFY_ROOT ?? process.cwd();
const writeExecutable = (file: string, text: string) => writeFileSync(file, text, { mode: 0o755 });

fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (override: boolean, existing: boolean, system: boolean, custom: boolean) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hobo-dev-bootstrap-property-'));
  try {
    const tools = path.join(dir, 'tools');
    const home = path.join(dir, 'home');
    const log = path.join(dir, 'calls');
    const installs = path.join(dir, 'installs');
    const installer = path.join(dir, 'installer.sh');
    const target = override ? path.join(dir, 'selected', custom ? 'custom-mise' : 'mise') : path.join(home, '.local/bin/mise');
    mkdirSync(tools);
    mkdirSync(home);
    for (const name of ['bash', 'sh', 'dirname', 'mkdir', 'cat', 'chmod']) {
      const command = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync);
      assert.ok(command, `missing test command ${name}`);
      writeExecutable(path.join(tools, name), `#!/bin/sh\nexec "${command}" "$@"\n`);
    }
    writeExecutable(path.join(tools, 'curl'), '#!/bin/sh\ncat "$HOBO_BOOTSTRAP_INSTALLER"\n');
    const fake = '#!/bin/sh\nprintf "%s|%s\\n" "$0" "$*" >> "$HOBO_BOOTSTRAP_LOG"\n';
    if (system) writeExecutable(path.join(tools, 'mise'), fake);
    if (existing) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeExecutable(target, fake);
    }
    writeFileSync(installer, [
      'target="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"',
      'mkdir -p "$(dirname "$target")"',
      'cat > "$target" <<\'FAKE_MISE\'',
      fake.trimEnd(),
      'FAKE_MISE',
      'chmod +x "$target"',
      'printf "installed\\n" >> "$HOBO_BOOTSTRAP_INSTALLS"',
      '',
    ].join('\n'));
    const env: NodeJS.ProcessEnv = {
      PATH: tools,
      HOME: home,
      HOBO_SKIP_DOTFILES: '1',
      MISE_INSTALL_URL: 'https://unused.invalid/mise',
      HOBO_BOOTSTRAP_INSTALLER: installer,
      HOBO_BOOTSTRAP_LOG: log,
      HOBO_BOOTSTRAP_INSTALLS: installs,
    };
    if (override) env.MISE_INSTALL_PATH = target;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('bash', ['scripts/bootstrap-dev.sh', '--project-only'], { cwd: root, env, encoding: 'utf8' });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${JSON.stringify({ override, existing, system, custom })}: ${result.stderr}`);
    }
    const installNeeded = !existing && (override || !system);
    assert.equal(existsSync(installs) ? readFileSync(installs, 'utf8') : '', installNeeded ? 'installed\n' : '');
    const selected = !override && !existing && system ? path.join(tools, 'mise') : target;
    const expected = [`${selected}|trust ${path.join(root, 'mise.toml')}`, `${selected}|install`, `${selected}|activate bash`];
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [...expected, ...expected]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}), { seed: 614781, numRuns: 40 });
console.log('PASS: generated bootstrap selections and installation reuse');
