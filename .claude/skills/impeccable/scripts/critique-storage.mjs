#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCritiqueDir } from './lib/impeccable-paths.mjs';
import { slugFromTarget } from './lib/target-slug.mjs';

export { slugFromTarget } from './lib/target-slug.mjs';

export function nowFilenameStamp(date = new Date()) {
  const iso = date.toISOString();
  return iso.replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z');
}

export function writeSnapshot() {
  throw new Error('Repository policy forbids critique files');
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (/^".*"$/.test(value)) {
      try { value = JSON.parse(value); } catch {   }
    } else if (/^-?\d+$/.test(value)) {
      value = Number(value);
    }
    out[key] = value;
  }
  return out;
}

function listSnapshotsForSlug(slug, cwd) {
  const dir = getCritiqueDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const suffix = `__${slug}.md`;
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => path.join(dir, f));
}

export function readLatestSnapshot(slug, { cwd = process.cwd() } = {}) {
  const all = listSnapshotsForSlug(slug, cwd);
  if (!all.length) return null;
  const latest = all[all.length - 1];
  const body = fs.readFileSync(latest, 'utf-8');
  return { path: latest, body, meta: parseFrontmatter(body) };
}

export function readTrend(slug, { limit = 5, cwd = process.cwd() } = {}) {
  const all = listSnapshotsForSlug(slug, cwd);
  const slice = all.slice(-limit);
  return slice.map((file) => parseFrontmatter(fs.readFileSync(file, 'utf-8')));
}


function coerceSlug(value) {
  if (!value) return null;
  if (/^[a-z0-9-]+$/.test(value) && !value.includes('/')) return value;
  return slugFromTarget(value);
}

function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'slug': {
      const slug = slugFromTarget(args[0]);
      if (!slug) { process.stderr.write('no stable slug for input\n'); process.exit(1); }
      process.stdout.write(`${slug}\n`);
      return;
    }
    case 'write': {
      const [slugArg, bodyFile] = args;
      const slug = coerceSlug(slugArg);
      if (!slug || !bodyFile) { process.stderr.write('usage: write <slug-or-target> <body-file>\n'); process.exit(1); }
      const raw = fs.readFileSync(bodyFile, 'utf-8');
      let meta = {};
      const metaArg = process.env.IMPECCABLE_CRITIQUE_META;
      if (metaArg) {
        try { meta = JSON.parse(metaArg); } catch {   }
      }
      const out = writeSnapshot({ slug, meta, body: raw });
      process.stdout.write(`${out}\n`);
      return;
    }
    case 'latest': {
      const latest = readLatestSnapshot(coerceSlug(args[0]));
      if (!latest) { process.exit(2); }
      process.stdout.write(latest.body);
      return;
    }
    case 'trend': {
      const rows = readTrend(coerceSlug(args[0]), { limit: args[1] ? Number(args[1]) : 5 });
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    default:
      process.stderr.write('usage: critique-storage.mjs <slug|write|latest|trend> [args]\n');
      process.exit(1);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2));
}
