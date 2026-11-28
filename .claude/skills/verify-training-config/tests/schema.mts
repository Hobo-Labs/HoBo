import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cue = process.env.HOBO_CUE_BIN ?? 'cue';
const schema = process.env.TRAINING_CONFIG_VERIFY_CUE_PATH ?? path.resolve('packages/training/data-models/training_optimizer.cue');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-training-config-cue-'));
try {
  const version = spawnSync(cue, ['version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0 || !version.stdout.includes('cue version v0.14.0')) throw new Error('CUE 0.14.0 is required; set HOBO_CUE_BIN to its executable');
  copyFileSync(schema, path.join(scratch, 'schema.cue'));
  const run = (name, body) => {
    writeFileSync(path.join(scratch, `${name}.cue`), `package training_optimizer\n${body}\n`);
    return spawnSync(cue, ['vet', '-c', 'schema.cue', `${name}.cue`], { cwd: scratch, encoding: 'utf8' });
  };
  const valid = run('valid', 'ok: #OptimizerConfig & {seed: 1, max_iterations: 4294967295, demos_per_candidate: 1}');
  if (valid.error || valid.status !== 0) throw new Error(`valid CUE config failed: ${valid.stderr}`);
  const validOther = run('valid-other', 'ok: #OptimizerConfig & {seed: 1, max_iterations: 1, demos_per_candidate: 4294967295}');
  if (validOther.error || validOther.status !== 0) throw new Error(`valid CUE config failed: ${validOther.stderr}`);
  for (const field of ['max_iterations', 'demos_per_candidate']) {
    for (const value of ['0', '1.5', '4294967296']) {
      const invalid = run('invalid', `bad: #OptimizerConfig & {seed: 1, ${field}: ${value}}`);
      const output = `${invalid.stdout}\n${invalid.stderr}`;
      if (invalid.error || invalid.status === 0 || !output.includes(field) || (!output.includes('out of bound') && !output.includes('conflicting values'))) throw new Error(`expected CUE rejection for ${field}=${value}: ${output}`);
      process.stdout.write(`CUE rejected ${field}=${value}\n`);
    }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
