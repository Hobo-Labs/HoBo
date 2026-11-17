
import fs from 'node:fs';
import path from 'node:path';

import {
  PRODUCT_SCHEMA_VERSION,
  PRODUCT_DEPRECATED_SECTIONS,
  PRODUCT_V4_SECTIONS,
  readProductSchemaVersion,
} from './artifact-schema.mjs';

const KNOWN_CONFIG_KEYS = new Set([
  'hook',
  'detector',
  'updateCheck',
  'stalenessCheck',
  'projectRoots',
  '$schema',
  'version',
]);

const KNOWN_DETECTOR_KEYS = new Set([
  'ignoreRules',
  'ignoreFiles',
  'ignoreValues',
  'designSystem',
  'extensions',
]);

const NATIVE_EVIDENCE_PATHS = Object.freeze([
  { rel: 'pubspec.yaml', platform: 'adaptive', reason: 'a Flutter pubspec.yaml' },
  { rel: 'ios/Podfile', platform: 'ios', reason: 'an ios/Podfile' },
  { rel: 'android/build.gradle', platform: 'android', reason: 'an android/build.gradle' },
  { rel: 'android/build.gradle.kts', platform: 'android', reason: 'an android/build.gradle.kts' },
  { rel: 'ios/Runner.xcodeproj', platform: 'ios', reason: 'an ios/Runner.xcodeproj' },
]);

const NATIVE_EVIDENCE_DEPENDENCIES = Object.freeze([
  { name: 'react-native', platform: 'adaptive', reason: 'a react-native dependency' },
  { name: 'expo', platform: 'adaptive', reason: 'an expo dependency' },
  { name: '@react-native/metro-config', platform: 'adaptive', reason: 'a React Native metro config dependency' },
]);

function finding({ id, artifact, filePath = null, severity, summary, fix }) {
  return { id, artifact, path: filePath, severity, summary, fix };
}

export function designSidecarCandidatesFor(projectRoot, contextDir = projectRoot) {
  const candidates = [
    path.join(projectRoot, '.impeccable', 'design.json'),
    path.join(projectRoot, 'DESIGN.json'),
  ];
  const contextLegacy = path.join(contextDir || projectRoot, 'DESIGN.json');
  if (!candidates.includes(contextLegacy)) candidates.push(contextLegacy);
  return candidates;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}\\s*$`, 'im').test(String(markdown || ''));
}

function toRelative(filePath, root) {
  if (!filePath) return null;
  const rel = path.relative(root, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : filePath;
}


export function checkProduct(product, productPath = 'PRODUCT.md') {
  if (!product) return [];
  const findings = [];

  for (const [heading, reason] of Object.entries(PRODUCT_DEPRECATED_SECTIONS)) {
    if (!hasSection(product, heading)) continue;
    findings.push(finding({
      id: `product-deprecated-${heading.toLowerCase()}`,
      artifact: 'PRODUCT.md',
      filePath: productPath,
      severity: 'mention',
      summary: `PRODUCT.md still carries a \`## ${heading}\` section. ${reason}`,
      fix: `Treat \`## ${heading}\` as absent for every decision this session. `
        + 'Offer to delete the section; do not let its value influence the work either way.',
    }));
  }

  const stamped = readProductSchemaVersion(product);
  if (stamped === null && !PRODUCT_V4_SECTIONS.some((section) => hasSection(product, section))) {
    findings.push(finding({
      id: 'product-schema-legacy',
      artifact: 'PRODUCT.md',
      filePath: productPath,
      severity: 'route',
      summary: 'PRODUCT.md has no schema stamp and none of the sections the current record adds '
        + `(${PRODUCT_V4_SECTIONS.join(', ')}), so it predates this version of the product record.`,
      fix: 'Offer `init`, which preserves confirmed answers and fills the gaps by interview. '
        + 'Do not rewrite the file from inference.',
    }));
  } else if (stamped !== null && stamped < PRODUCT_SCHEMA_VERSION) {
    findings.push(finding({
      id: 'product-schema-outdated',
      artifact: 'PRODUCT.md',
      filePath: productPath,
      severity: 'route',
      summary: `PRODUCT.md is stamped product-schema ${stamped}; the current record is ${PRODUCT_SCHEMA_VERSION}.`,
      fix: 'Offer `init` to bring the record current, preserving confirmed answers.',
    }));
  }

  return findings;
}

export function checkNativePlatformEvidence({ projectRoot, platform, product, productPath }) {
  if (!projectRoot) return [];
  if (platform && platform !== 'web') return [];

  const evidence = [];
  for (const entry of NATIVE_EVIDENCE_PATHS) {
    if (fs.existsSync(path.join(projectRoot, entry.rel))) evidence.push(entry);
  }
  const pkg = readJson(path.join(projectRoot, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const entry of NATIVE_EVIDENCE_DEPENDENCIES) {
      if (deps[entry.name]) evidence.push(entry);
    }
  }
  if (!evidence.length) return [];

  const platforms = new Set(evidence.map((entry) => entry.platform));
  const suggested = platforms.size > 1 || platforms.has('adaptive')
    ? 'adaptive'
    : [...platforms][0];
  const declared = platform === 'web'
    ? 'PRODUCT.md declares `## Platform: web`'
    : product
      ? 'PRODUCT.md has no `## Platform` section, so the project resolves to web'
      : 'no PRODUCT.md declares a platform, so the project resolves to web';

  return [finding({
    id: 'platform-native-evidence',
    artifact: 'PRODUCT.md',
    filePath: productPath || null,
    severity: 'mention',
    summary: `${declared}, but the project carries ${evidence.map((entry) => entry.reason).join(' and ')}. `
      + 'Web guidance is being applied to a native codebase, and the iOS and Android references never load.',
    fix: `Ask the user whether \`## Platform\` should be \`${suggested}\`. `
      + 'If it should, write the value and load the matching native reference before designing.',
  })];
}


export function checkDesignSidecar({ sidecarCandidates = [], projectRoot }) {
  return sidecarCandidates.filter((candidate) => fs.existsSync(candidate)).map((candidate) => finding({
    id: 'design-artifact-present',
    artifact: 'design.json',
    filePath: toRelative(candidate, projectRoot),
    severity: 'mention',
    summary: `${toRelative(candidate, projectRoot)} is a design artifact prohibited by repository policy.`,
    fix: 'Complete any unfinished behavior, then remove the artifact.',
  }));
}


export function checkConfig({ projectRoot, repoRoot }) {
  const findings = [];
  const roots = [...new Set([projectRoot, repoRoot].filter(Boolean).map((root) => path.resolve(root)))];
  for (const root of roots) {
    for (const name of ['config.json', 'config.local.json']) {
      const filePath = path.join(root, '.impeccable', name);
      const raw = readJson(filePath);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const rel = toRelative(filePath, projectRoot || root);

      const unknownTop = Object.keys(raw).filter((key) => !KNOWN_CONFIG_KEYS.has(key));
      if (unknownTop.length) {
        findings.push(finding({
          id: 'config-unknown-keys',
          artifact: 'config.json',
          filePath: rel,
          severity: 'mention',
          summary: `${rel} has top-level key(s) nothing reads: ${unknownTop.map((key) => `\`${key}\``).join(', ')}. `
            + `Recognized keys are ${[...KNOWN_CONFIG_KEYS].map((key) => `\`${key}\``).join(', ')}.`,
          fix: 'Report the exact keys to the user. A near-miss of a real key is a setting that has never applied.',
        }));
      }

      const detector = raw.detector;
      if (detector && typeof detector === 'object' && !Array.isArray(detector)) {
        const unknownDetector = Object.keys(detector).filter((key) => !KNOWN_DETECTOR_KEYS.has(key));
        if (unknownDetector.length) {
          findings.push(finding({
            id: 'config-unknown-detector-keys',
            artifact: 'config.json',
            filePath: rel,
            severity: 'mention',
            summary: `${rel} has \`detector\` key(s) nothing reads: ${unknownDetector.map((key) => `\`${key}\``).join(', ')}. `
              + `Recognized keys are ${[...KNOWN_DETECTOR_KEYS].map((key) => `\`${key}\``).join(', ')}.`,
            fix: 'Report the exact keys. `ignoreRule` for `ignoreRules` is the common one, and it silences nothing.',
          }));
        }
      }
    }
  }
  return findings;
}


export function checkSurfaceBriefs({ candidates = [] }) {
  return candidates.map((brief) => finding({
    id: 'surface-brief-present',
    artifact: 'surface brief',
    filePath: brief.path || null,
    severity: 'mention',
    summary: `${brief.path || 'A surface brief'} is prohibited by repository policy.`,
    fix: 'Complete any unfinished behavior, then remove the brief.',
  }));
}


export function checkProjectRoots({ patterns = [], candidates = [], configuredIn = '.impeccable/config.json' }) {
  const positive = patterns.filter((pattern) => pattern && !String(pattern).trim().startsWith('!'));
  if (!positive.length || candidates.length) return [];
  return [finding({
    id: 'config-project-roots-match-nothing',
    artifact: 'config.json',
    filePath: configuredIn,
    severity: 'mention',
    summary: `\`projectRoots\` declares ${positive.map((pattern) => `\`${pattern}\``).join(', ')}, `
      + 'but no directory matches any of them, so the repo root is being treated as the active project.',
    fix: 'Report the patterns and ask which directories they should name. A renamed workspace folder is the usual cause.',
  })];
}

export function describeWorkspaceContext(candidates = []) {
  return candidates.map((candidate) => ({
    name: candidate.name,
    path: candidate.path,
    productStatus: candidate.productStatus,
    productPath: candidate.productPath,
    designStatus: candidate.designStatus,
    designPath: candidate.designPath,
  }));
}


export function collectBootFindings(ctx, extras = {}) {
  if (!ctx) return [];
  const projectRoot = ctx.projectRoot || process.cwd();
  const absProductPath = extras.absProductPath || null;
  const absDesignPath = extras.absDesignPath || null;

  return [
    ...checkProduct(ctx.product, ctx.productPath || 'PRODUCT.md'),
    ...(ctx.product
      ? checkNativePlatformEvidence({
          projectRoot,
          platform: ctx.platform,
          product: ctx.product,
          productPath: ctx.productPath,
        })
      : []),
    ...checkDesignSidecar({
      designPath: absDesignPath,
      sidecarCandidates: extras.sidecarCandidates || [],
      projectRoot,
    }),
    ...checkConfig({ projectRoot, repoRoot: ctx.repoRoot }),
    ...checkSurfaceBriefs({ candidates: ctx.surfaceBriefCandidates, projectRoot }),
    ...(extras.projectRootPatterns
      ? checkProjectRoots({
          patterns: extras.projectRootPatterns,
          candidates: extras.targetCandidates || [],
        })
      : []),
  ];
}
