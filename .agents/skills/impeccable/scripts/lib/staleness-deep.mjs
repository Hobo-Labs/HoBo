
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VISUAL_SOURCE_DIRS = ['src', 'app', 'pages', 'components', 'site', 'styles', 'public'];

const HOOK_MANIFESTS_BY_PROVIDER = Object.freeze({
  'claude-code': ['.claude/settings.local.json', '.claude/settings.json'],
  codex: ['.codex/hooks.json'],
  agents: ['.codex/hooks.json'],
  cursor: ['.cursor/hooks.json'],
  github: ['.github/hooks/impeccable.json'],
  grok: ['.grok/hooks/impeccable.json'],
});

const HOOK_SCRIPT_MARKERS = [
  'skills/impeccable/scripts/hook.mjs',
  'skills/impeccable/scripts/hook-before-edit.mjs',
];

const LEGACY_LIVE_PATHS = ['.impeccable-live.json', '.impeccable-live'];

function finding({ id, artifact, filePath = null, severity, summary, fix }) {
  return { id, artifact, path: filePath, severity, summary, fix };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function toRelative(filePath, root) {
  if (!filePath) return null;
  const rel = path.relative(root, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : filePath;
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}


export function checkDesignDrift({ designPath, projectRoot, threshold = 25 }) {
  if (!designPath || !projectRoot) return [];
  if (!git(['rev-parse', '--is-inside-work-tree'], projectRoot)) return [];

  const relDesign = toRelative(designPath, projectRoot);
  const lastDesignCommit = git(['log', '-1', '--format=%H', '--', relDesign], projectRoot);
  if (!lastDesignCommit) return [];

  const dirs = VISUAL_SOURCE_DIRS.filter((dir) => fs.existsSync(path.join(projectRoot, dir)));
  if (!dirs.length) return [];

  const log = git(
    ['log', '--oneline', `${lastDesignCommit}..HEAD`, '--', ...dirs],
    projectRoot,
  );
  if (log === null) return [];
  const commits = log ? log.split('\n').filter(Boolean).length : 0;
  if (commits < threshold) return [];

  const when = git(['log', '-1', '--format=%ad', '--date=short', '--', relDesign], projectRoot);
  return [finding({
    id: 'design-md-drift',
    artifact: 'DESIGN.md',
    filePath: relDesign,
    severity: 'route',
    summary: `${commits} commits have touched ${dirs.join(', ')} since ${relDesign} was last edited`
      + `${when ? ` (${when})` : ''}. This counts commits, not contradictions: it says the document is worth `
      + 're-reading, not that it is wrong.',
    fix: 'Complete any unfinished behavior, then remove the design document.',
  })];
}

function hasCoverageValue(value) {
  if (Array.isArray(value)) return value.some(hasCoverageValue);
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasCoverageValue);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 && !/^(?:\[\s*\]|\{\s*\})$/.test(trimmed);
  }
  return false;
}

const SEED_DESIGN_MARKERS = ['/', '$'].map((prefix) =>
  '<!-- SEED: established with the user before implementation; '
    + `re-run ${prefix}impeccable document once there's code to capture the actual tokens and components. -->`
);

export function checkDesignCoverage({ design, designPath, parseDesignMd }) {
  if (!design || typeof parseDesignMd !== 'function') return [];
  let model;
  try {
    model = parseDesignMd(design);
  } catch {
    return [];
  }
  const isSeed = SEED_DESIGN_MARKERS.some((marker) => design.includes(marker));
  const requiredSections = isSeed
    ? ['colors', 'typography']
    : ['colors', 'typography', 'components'];
  const missing = requiredSections
    .filter((section) => !model[section] && !hasCoverageValue(model.frontmatter?.[section]));
  if (!missing.length) return [];
  return [finding({
    id: 'design-md-coverage',
    artifact: 'DESIGN.md',
    filePath: designPath,
    severity: 'mention',
    summary: `${designPath || 'DESIGN.md'} has no ${missing.join(', ')} section. `
      + 'Agents generating new screens get no normative guidance for those, and the live design panel renders '
      + 'generic approximations in their place.',
    fix: 'Complete any unfinished behavior, then remove the design document.',
  })];
}


export function checkDetectorIgnores({ projectRoot, knownRuleIds = null }) {
  const findings = [];
  if (!projectRoot) return findings;

  for (const name of ['config.json', 'config.local.json']) {
    const filePath = path.join(projectRoot, '.impeccable', name);
    const raw = readJson(filePath);
    const detector = raw?.detector;
    if (!detector || typeof detector !== 'object') continue;
    const rel = toRelative(filePath, projectRoot);

    if (knownRuleIds && Array.isArray(detector.ignoreRules)) {
      const unknown = detector.ignoreRules
        .map((rule) => String(rule || '').trim().toLowerCase())
        .filter((rule) => rule && rule !== '*' && !knownRuleIds.has(rule));
      if (unknown.length) {
        findings.push(finding({
          id: 'detector-ignore-rules-unknown',
          artifact: 'config.json',
          filePath: rel,
          severity: 'mention',
          summary: `${rel} ignores rule id(s) the detector does not have: `
            + `${unknown.map((rule) => `\`${rule}\``).join(', ')}. Either the rule was renamed or removed, or the `
            + 'id was mistyped and has never suppressed anything.',
          fix: 'Report the exact ids. Removing them is safe; keeping a dead ignore hides that the rule is gone.',
        }));
      }
    }

    if (Array.isArray(detector.ignoreFiles)) {
      const missing = detector.ignoreFiles
        .map((entry) => String(entry || '').trim())
        .filter((entry) => entry && !entry.includes('*') && !fs.existsSync(path.join(projectRoot, entry)));
      if (missing.length) {
        findings.push(finding({
          id: 'detector-ignore-files-missing',
          artifact: 'config.json',
          filePath: rel,
          severity: 'mention',
          summary: `${rel} ignores file path(s) that no longer exist: `
            + `${missing.map((entry) => `\`${entry}\``).join(', ')}.`,
          fix: 'Ask whether the file moved (repoint the entry) or was deleted (drop it). '
            + 'A stale entry silently stops covering the file that replaced it.',
        }));
      }
    }
  }
  return findings;
}


function collectHookCommands(value, out = []) {
  if (typeof value === 'string') {
    if (HOOK_SCRIPT_MARKERS.some((marker) => value.includes(marker))) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHookCommands(entry, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectHookCommands(entry, out);
  }
  return out;
}

const HOOK_MARKER = /skills\/impeccable\/scripts\/hook(?:-before-edit)?\.mjs/;

function hookScriptTokenFrom(command) {
  const str = String(command);
  if (!HOOK_MARKER.test(str)) return null;
  const quoted = str.match(/"([^"]*skills\/impeccable\/scripts\/hook(?:-before-edit)?\.mjs)"/);
  if (quoted) return quoted[1];
  const bare = str.match(/([^\s"'|&;()]*skills\/impeccable\/scripts\/hook(?:-before-edit)?\.mjs)/);
  return bare ? bare[1] : null;
}

function resolveHookScriptPath(token, root) {
  if (!token) return null;
  if (token.includes('$(') || token.includes('`')) return null;
  const expanded = token.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, root);
  if (/\$\{[^}]*\}|\$[A-Za-z_]/.test(expanded)) return null;
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

export function checkHookInstallation({ projectRoot, repoRoot, providerId }) {
  const findings = [];
  const manifests = HOOK_MANIFESTS_BY_PROVIDER[providerId] || [];
  if (!manifests.length) return findings;

  const roots = [...new Set([projectRoot, repoRoot].filter(Boolean).map((root) => path.resolve(root)))];
  let installedAt = null;

  for (const root of roots) {
    for (const rel of manifests) {
      const manifestPath = path.join(root, rel);
      const raw = readJson(manifestPath);
      if (!raw?.hooks) continue;
      const commands = collectHookCommands(raw.hooks);
      if (!commands.length) continue;
      installedAt = toRelative(manifestPath, projectRoot || root);

      const broken = commands.filter((command) => {
        const token = hookScriptTokenFrom(command);
        if (!token) return false;
        const abs = resolveHookScriptPath(token, root);
        if (!abs) return false;
        return !fs.existsSync(abs);
      });
      if (broken.length) {
        findings.push(finding({
          id: 'hook-script-missing',
          artifact: 'hook manifest',
          filePath: installedAt,
          severity: 'mention',
          summary: `${installedAt} installs the design hook, but its script path does not exist: `
            + `${broken.map((command) => `\`${command}\``).join(', ')}. The hook runs as a no-op, so UI edits `
            + 'have been going unscanned while the project looks covered.',
          fix: `Reinstall with \`impeccable hooks on\`, which rewrites the manifest against the skill's current location.`,
        }));
      }
    }
  }

  if (installedAt) {
    for (const root of roots) {
      for (const name of ['config.json', 'config.local.json']) {
        const raw = readJson(path.join(root, '.impeccable', name));
        if (raw?.hook && raw.hook.enabled === false) {
          findings.push(finding({
            id: 'hook-enabled-conflict',
            artifact: 'config.json',
            filePath: toRelative(path.join(root, '.impeccable', name), projectRoot || root),
            severity: 'mention',
            summary: `${installedAt} installs the design hook while this config sets \`hook.enabled: false\`, `
              + 'so the hook fires and then declines to scan.',
            fix: 'Ask which was intended: `impeccable hooks on` to enable, or `impeccable hooks off` to uninstall '
              + 'the manifest entry as well.',
          }));
          return findings;
        }
      }
    }
  }

  return findings;
}


export function checkLegacyLiveState({ projectRoot }) {
  if (!projectRoot) return [];
  const present = LEGACY_LIVE_PATHS.filter((rel) => fs.existsSync(path.join(projectRoot, rel)));
  if (!present.length) return [];
  return [finding({
    id: 'legacy-live-state',
    artifact: 'live state',
    filePath: present.join(', '),
    severity: 'auto',
    summary: `Live-mode state sits in retired location(s): ${present.map((rel) => `\`${rel}\``).join(', ')}. `
      + 'Current live mode writes under `.impeccable/live/`.',
    fix: 'These are read only through backward-compatible fallbacks and are safe to delete once no live session '
      + 'is running. No user decision is needed.',
  })];
}


export function checkWorkspaces({ repoRoot, candidates = [], checkNativePlatformEvidence, extractPlatform, readFile }) {
  if (!repoRoot || !candidates.length) return { findings: [], workspaces: [] };
  const findings = [];
  const workspaces = [];

  for (const candidate of candidates) {
    const workspaceRoot = path.join(repoRoot, candidate.path);
    const productPath = candidate.productPath ? path.join(repoRoot, candidate.productPath) : null;
    const product = productPath && readFile ? readFile(productPath) : null;
    const platform = extractPlatform ? extractPlatform(product) : null;

    workspaces.push({
      name: candidate.name,
      path: candidate.path,
      productStatus: candidate.productStatus,
      productPath: candidate.productPath,
      designStatus: candidate.designStatus,
      designPath: candidate.designPath,
      platform: platform || (product ? 'web (default)' : null),
    });

    if (!checkNativePlatformEvidence) continue;
    const native = checkNativePlatformEvidence({
      projectRoot: workspaceRoot,
      platform,
      product,
      productPath: candidate.productPath,
    });
    for (const entry of native) {
      findings.push(finding({
        id: 'workspace-platform-native-evidence',
        artifact: 'PRODUCT.md',
        filePath: candidate.productPath || `${candidate.path}/PRODUCT.md`,
        severity: 'mention',
        summary: `Workspace \`${candidate.path}\` ${
          candidate.productStatus === 'inherited'
            ? 'inherits the repo-root PRODUCT.md'
            : 'has a PRODUCT.md'
        } that resolves to web, but the workspace itself carries native build files. ${entry.summary}`,
        fix: candidate.productStatus === 'inherited'
          ? `Give \`${candidate.path}\` its own PRODUCT.md with the right \`## Platform\`. `
            + 'An inherited record cannot describe two platforms at once.'
          : entry.fix,
      }));
    }
  }

  const inherited = workspaces.filter((entry) => entry.productStatus === 'inherited');
  if (inherited.length) {
    findings.push(finding({
      id: 'workspace-context-inherited',
      artifact: 'PRODUCT.md',
      filePath: null,
      severity: 'mention',
      summary: `${inherited.length} of ${workspaces.length} workspace(s) inherit the repo-root PRODUCT.md: `
        + `${inherited.map((entry) => `\`${entry.path}\``).join(', ')}. Inheritance is intended; whether one `
        + 'record truthfully describes these apps is not something this check can tell.',
      fix: 'Ask the user whether the inherited record describes each app. Where it does not, `init` in that '
        + 'workspace writes a child PRODUCT.md that overrides it.',
    }));
  }

  return { findings, workspaces };
}


export async function loadKnownRuleIds(scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const candidates = [
    path.join(scriptsDir, 'detector', 'detect-antipatterns.mjs'),
    path.join(scriptsDir, '..', '..', 'cli', 'engine', 'detect-antipatterns.mjs'),
  ];
  const detectorPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!detectorPath) return null;
  try {
    const { ANTIPATTERNS } = await import(pathToFileURL(detectorPath).href);
    if (!Array.isArray(ANTIPATTERNS)) return null;
    return new Set(ANTIPATTERNS.map((rule) => String(rule.id).toLowerCase()));
  } catch {
    return null;
  }
}
