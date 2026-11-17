const esbuild = require('esbuild');
const path = require('path');

const root = path.resolve(__dirname, '..');

function buildHooks(outputDirectory = path.join(root, 'dist', 'hooks')) {
  esbuild.buildSync({
    entryPoints: [
      path.join(root, 'server', 'src', 'providers', 'hook', 'claude', 'hooks', 'claude-hook.ts'),
    ],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: outputDirectory,
    banner: { js: '#!/usr/bin/env node' },
  });
}

if (require.main === module) buildHooks(process.argv[2]);

module.exports = { buildHooks };
