import { isJsonObject } from "./json.js";
export const REQUIRED_EVIDENCE_SOURCES = [
  "e2e-tests",
  "accessibility-checks",
  "bootstrap-smoke",
  "docs",
  "support-guidance",
  "known-limitation",
];

export const REQUIRED_SUPPORT_ROUTES = [
  "support-debug",
  "release-notes",
  "known-limitations-register",
];

const SUPPORT_LEVELS = new Set(["supported", "limited", "unsupported"]);
const EVIDENCE_SOURCES = new Set(REQUIRED_EVIDENCE_SOURCES);
const SCOPE_CREEP_PATTERNS = [
  /device lab/i,
  /native mobile/i,
  /mobile app/i,
  /automated browser grid/i,
  /cross-browser farm/i,
  /real device coverage/i,
];

export const V1_SUPPORTED_PLATFORM_MATRIX = {
  issue: "HOBO-511",
  project: "Compatibility Matrix",
  phase: "M0",
  goal:
    "Define the v1 user-facing browser, device, and platform support contract so release, support, docs, and local bootstrap claims route to explicit evidence or limitations.",
  personas: [
    {
      role: "app developer",
      need: "Know whether the web UX and local CLI path are supported on their daily development machine.",
    },
    {
      role: "platform engineer",
      need: "Know which OS/browser assumptions affect rollout, support, and bootstrap instructions.",
    },
    {
      role: "support operator",
      need: "Classify unsupported environment reports without inventing support promises.",
    },
    {
      role: "release owner",
      need: "Publish beta and GA support claims only when evidence exists or a limitation is documented.",
    },
  ],
  desktopBrowsers: [
    browser("Chrome", "current and previous stable", "supported", "supported", ["e2e-tests", "accessibility-checks", "docs"]),
    browser("Edge", "current and previous stable", "supported", "supported", ["e2e-tests", "accessibility-checks", "docs"]),
    browser("Firefox", "current stable", "limited", "supported", ["e2e-tests", "accessibility-checks", "known-limitation"]),
    browser("Safari", "current stable on macOS", "limited", "limited", ["e2e-tests", "accessibility-checks", "known-limitation"]),
  ],
  responsivePosture: {
    supportLevel: {
      beta: "limited",
      ga: "limited",
    },
    minimumViewport: {
      width: 390,
      height: 844,
      basis: "Small mobile responsive floor for reading status, docs, and support guidance; primary authoring stays desktop-first for v1.",
    },
    supportedUses: [
      "read release notes and known limitations",
      "inspect status and support guidance",
      "complete lightweight account/session recovery",
    ],
    unsupportedUses: [
      "full topology editing",
      "large plan diff review",
      "provider credential bootstrap",
    ],
  },
  cliAndLocalBootstrap: [
    platform("macOS", ["arm64", "x64"], "supported", "supported", ["bootstrap-smoke", "docs", "support-guidance"]),
    platform("Linux", ["x64", "arm64"], "supported", "supported", ["bootstrap-smoke", "docs", "support-guidance"]),
    platform("Windows", ["x64"], "limited", "supported", ["bootstrap-smoke", "docs", "known-limitation"]),
  ],
  unsupportedEnvironments: [
    {
      id: "legacy-browser",
      examples: ["Internet Explorer", "old embedded WebView"],
      releaseNoteClass: "unsupported-browser",
      route: "support-debug",
    },
    {
      id: "narrow-mobile-authoring",
      examples: ["viewport width below 390px", "full authoring on phone"],
      releaseNoteClass: "mobile-responsive-limitation",
      route: "release-notes",
    },
    {
      id: "unsupported-cli-os",
      examples: ["FreeBSD", "unsupported Linux distro", "Windows ARM64 before smoke evidence"],
      releaseNoteClass: "unsupported-platform",
      route: "known-limitations-register",
    },
    {
      id: "headless-no-browser",
      examples: ["locked-down browserless support terminal"],
      releaseNoteClass: "unsupported-device",
      route: "support-debug",
    },
  ],
  supportClaims: [
    claim("desktop-browser-current", "Desktop web UX supports current stable Chrome, Edge, Firefox, and Safari levels named in this matrix.", "release owner", [
      "e2e-tests",
      "accessibility-checks",
      "docs",
    ]),
    claim("mobile-responsive-floor", "Mobile/responsive v1 is a limited read/support posture with a 390px viewport floor.", "product UX owner", [
      "accessibility-checks",
      "docs",
      "known-limitation",
    ]),
    claim("cli-local-bootstrap", "Local CLI/bootstrap support is scoped to macOS, Linux, and Windows rows named in this matrix.", "bootstrap owner", [
      "bootstrap-smoke",
      "docs",
      "support-guidance",
    ]),
    claim("unsupported-report-routing", "Unsupported browser/device/platform reports route to support debug, release notes, or the known limitations register.", "support operator", [
      "support-guidance",
      "known-limitation",
    ]),
    claim("package-runtime-versions", "Package/runtime version compatibility remains a separate compatibility input, not the whole user-facing matrix.", "release owner", [
      "docs",
    ]),
  ],
  unsupportedReportRoutes: [
    {
      destination: "support-debug",
      owner: "support operator",
      handles: "customer report needs environment capture, reproduction note, and unsupported/supported classification",
    },
    {
      destination: "release-notes",
      owner: "release owner",
      handles: "known unsupported or limited environment should be visible in release notes and upgrade guidance",
    },
    {
      destination: "known-limitations-register",
      owner: "product owner",
      handles: "accepted v1 limitation or GA blocker needs durable tracking without promising support",
    },
  ],
  dependencies: [
    {
      source: "docs/design/release-notes-upgrade-guide.md",
      reason: "Release notes must publish supported install paths, compatibility matrix inputs, and known limitations.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Support needs unsupported environment routing and debug evidence.",
    },
    {
      source: "docs/design/workspace-onboarding-ux.md",
      reason: "Workspace onboarding owns browser-visible first-run and responsive UX expectations.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "CLI, local bootstrap, dashboard, docs, and support-facing DX surfaces consume this matrix.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0082",
      reason: "Default-on verification evidence prevents unsupported launch claims.",
    },
  ],
  scopeIn: [
    "Define supported desktop browser rows and beta/GA support levels.",
    "Define mobile/responsive posture, minimum viewport, supported lightweight uses, and unsupported authoring uses.",
    "Define OS/platform assumptions for CLI and local bootstrap smoke evidence.",
    "Map each support claim to evidence from e2e tests, accessibility checks, bootstrap smoke, docs, support guidance, or known limitations.",
    "Define support/debug and release-note routes for unsupported browser, device, viewport, and platform reports.",
  ],
  scopeOut: [
    "No broad device lab or real-device coverage program.",
    "No native mobile app or full mobile authoring implementation.",
    "No automated browser grid implementation.",
    "No live e2e execution or performance certification in this issue.",
    "No package/runtime compatibility replacement; this matrix adds user-facing environment support.",
  ],
};

export function validateSupportedPlatformMatrix(matrix) {
  const errors = [];

  if (!matrix || !isJsonObject(matrix)) {
    return { ok: false, errors: ["matrix is required"] };
  }
  if (matrix.issue !== "HOBO-511") errors.push("issue must be HOBO-511");
  if (matrix.phase !== "M0") errors.push("phase must be M0");
  if (!/browser|device|platform/i.test(matrix.goal ?? "")) {
    errors.push("goal must name browser, device, and platform support");
  }

  const browserNames = (matrix.desktopBrowsers ?? []).map((entry) => entry.name);
  for (const required of ["Chrome", "Edge", "Firefox", "Safari"]) {
    if (!browserNames.includes(required)) {
      errors.push(`missing desktop browser support row: ${required}`);
    }
  }
  for (const browserEntry of matrix.desktopBrowsers ?? []) {
    validateSupportPair(errors, browserEntry, `browser ${browserEntry.name}`);
    validateEvidence(errors, browserEntry.evidenceSources, `browser ${browserEntry.name}`);
  }

  const platformNames = (matrix.cliAndLocalBootstrap ?? []).map((entry) => entry.os);
  for (const required of ["macOS", "Linux", "Windows"]) {
    if (!platformNames.includes(required)) {
      errors.push(`missing CLI/local bootstrap platform row: ${required}`);
    }
  }
  for (const platformEntry of matrix.cliAndLocalBootstrap ?? []) {
    validateSupportPair(errors, platformEntry, `platform ${platformEntry.os}`);
    if (!Array.isArray(platformEntry.architectures) || platformEntry.architectures.length === 0) {
      errors.push(`platform ${platformEntry.os} must name architectures`);
    }
    validateEvidence(errors, platformEntry.evidenceSources, `platform ${platformEntry.os}`);
  }

  if (!matrix.responsivePosture?.minimumViewport || matrix.responsivePosture.minimumViewport.width < 390) {
    errors.push("responsive posture must define a minimum viewport of at least 390px");
  }
  if (!matrix.responsivePosture?.supportLevel?.beta || !matrix.responsivePosture?.supportLevel?.ga) {
    errors.push("responsive posture must name beta and GA support levels");
  }

  if ((matrix.unsupportedEnvironments ?? []).length < 4) {
    errors.push("unsupported environments must cover browser, mobile/viewport, CLI OS, and device classes");
  }

  const routeDestinations = (matrix.unsupportedReportRoutes ?? []).map((route) => route.destination);
  if (!arraysEqual(routeDestinations, REQUIRED_SUPPORT_ROUTES)) {
    errors.push(`unsupported report routes must be ${REQUIRED_SUPPORT_ROUTES.join(", ")}`);
  }

  const supportClaims = matrix.supportClaims ?? [];
  if (!supportClaims.some((claimEntry) => /browser/i.test(claimEntry.claim ?? ""))) {
    errors.push("support claims must include user-facing browser/device support");
  }
  if (!supportClaims.some((claimEntry) => /mobile|responsive|device/i.test(claimEntry.claim ?? ""))) {
    errors.push("support claims must include user-facing browser/device support");
  }
  for (const claimEntry of supportClaims) {
    if (!claimEntry.id || !claimEntry.claim || !claimEntry.owner) {
      errors.push(`support claim ${claimEntry.id ?? "<missing>"} must name id, claim, and owner`);
    }
    validateEvidence(errors, claimEntry.evidenceSources, `support claim ${claimEntry.id ?? "<missing>"}`);
  }
  const observedEvidence = new Set(supportClaims.flatMap((claimEntry) => claimEntry.evidenceSources ?? []));
  for (const required of REQUIRED_EVIDENCE_SOURCES) {
    if (!observedEvidence.has(required)) {
      errors.push(`missing support claim evidence source: ${required}`);
    }
  }

  if ((matrix.dependencies ?? []).length < 5) {
    errors.push("dependencies must map release notes, support, onboarding UX, DX, and verification ADR");
  }

  for (const entry of matrix.scopeIn ?? []) {
    if (SCOPE_CREEP_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyUnsupportedEnvironment({ browser, os, viewportWidth }) {
  if (browser && !["Chrome", "Edge", "Firefox", "Safari"].includes(browser)) {
    return {
      supportLevel: "unsupported",
      route: "support-debug",
      releaseNoteClass: "unsupported-browser",
    };
  }

  if (viewportWidth !== undefined && viewportWidth < V1_SUPPORTED_PLATFORM_MATRIX.responsivePosture.minimumViewport.width) {
    return {
      supportLevel: "limited",
      route: "release-notes",
      releaseNoteClass: "mobile-responsive-limitation",
    };
  }

  if (os && !["macOS", "Linux", "Windows"].includes(os)) {
    return {
      supportLevel: "unsupported",
      route: "known-limitations-register",
      releaseNoteClass: "unsupported-platform",
    };
  }

  return {
    supportLevel: "supported",
    route: "support-debug",
    releaseNoteClass: "supported-environment-debug",
  };
}

function browser(name, versionPolicy, betaLevel, gaLevel, evidenceSources) {
  return {
    name,
    versionPolicy,
    beta: { level: betaLevel },
    ga: { level: gaLevel },
    evidenceSources,
  };
}

function platform(os, architectures, betaLevel, gaLevel, evidenceSources) {
  return {
    os,
    architectures,
    beta: { level: betaLevel },
    ga: { level: gaLevel },
    evidenceSources,
  };
}

function claim(id, claimText, owner, evidenceSources) {
  return {
    id,
    claim: claimText,
    owner,
    evidenceSources,
  };
}

function validateSupportPair(errors, entry, label) {
  if (!SUPPORT_LEVELS.has(entry.beta?.level)) {
    errors.push(`${label} must name a beta support level`);
  }
  if (!SUPPORT_LEVELS.has(entry.ga?.level)) {
    errors.push(`${label} must name a GA support level`);
  }
}

function validateEvidence(errors, evidenceSources, label) {
  if (!Array.isArray(evidenceSources) || evidenceSources.length === 0) {
    errors.push(`${label} must map to evidence sources`);
    return;
  }
  for (const source of evidenceSources) {
    if (!EVIDENCE_SOURCES.has(source)) {
      errors.push(`${label} uses unsupported evidence source ${source}`);
    }
  }
}

function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
