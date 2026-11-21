import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['models.py', 'implementation.py', 'proof.py']) {
  const script = fileURLToPath(new URL(`../mutations/${name}`, import.meta.url));
  const result = spawnSync('python3', [script], { env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
