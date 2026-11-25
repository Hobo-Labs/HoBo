export type BootstrapPathId = "saas-bootstrap" | "self-host-bootstrap" | "local-dev-bootstrap";

export type SmokeStageId =
  | "preflight"
  | "auth-seed"
  | "first-project"
  | "first-deploy"
  | "failure-recovery"
  | "cleanup-or-uninstall";

export type StageDisposition = "required" | "mocked" | "documented-boundary";

export type ResultFeedTarget = "release-notes" | "troubleshooting" | "support-handoff";

export type BootstrapLaunchSmokeStage = Readonly<{
  id: SmokeStageId;
  disposition: StageDisposition;
  fixtureIds: readonly string[];
  mockedBoundaryIds: readonly string[];
  resultId: string;
  proves: string;
}>;

export type BootstrapSeedAuthEvidence = Readonly<{
  credentialSource: string;
  allowedScopes: readonly string[];
  ttlSeconds: number;
  auditEvent: string;
  identityHandoff: string;
  noAmbientCloudKey: boolean;
  zeroEgressMode: boolean;
}>;

export type BootstrapLaunchSmokePath = Readonly<{
  id: BootstrapPathId;
  primaryUser: string;
  fixtures: readonly string[];
  mockedBoundaries: readonly string[];
  unsupportedStates: readonly string[];
  firstProjectContract: string;
  firstDeployContract: string;
  seedAuth: BootstrapSeedAuthEvidence;
  stages: readonly BootstrapLaunchSmokeStage[];
}>;

export type BootstrapLaunchSmokeResultFeed = Readonly<{
  target: ResultFeedTarget;
  owner: string;
  sourceResultIds: readonly string[];
  entries: readonly string[];
}>;

export type BootstrapLaunchSmokeMatrix = Readonly<{
  issue: "HOBO-501";
  phase: "M1";
  goal: string;
  paths: readonly BootstrapLaunchSmokePath[];
  resultFeeds: readonly BootstrapLaunchSmokeResultFeed[];
  scopeIn: readonly string[];
  scopeOut: readonly string[];
  designRefs: readonly string[];
  adrRefs: readonly string[];
}>;

export type MutableBootstrapLaunchSmokeMatrix = Omit<BootstrapLaunchSmokeMatrix, "paths" | "resultFeeds" | "scopeIn"> & {
  paths: BootstrapLaunchSmokePath[];
  resultFeeds: BootstrapLaunchSmokeResultFeed[];
  scopeIn: string[];
};

export type ValidationResult = Readonly<{
  ok: boolean;
  errors: readonly string[];
}>;

export type BootstrapLaunchEvidenceSummary = Readonly<{
  feedTargets: readonly ResultFeedTarget[];
  releaseNotes: readonly string[];
  troubleshooting: readonly string[];
  supportHandoff: readonly string[];
}>;

export type WorkClassification = Readonly<{
  owner: string;
  inScope: boolean;
}>;

const REQUIRED_PATH_IDS = Object.freeze([
  "saas-bootstrap",
  "self-host-bootstrap",
  "local-dev-bootstrap",
]) satisfies readonly BootstrapPathId[];

const REQUIRED_STAGE_IDS = Object.freeze([
  "preflight",
  "auth-seed",
  "first-project",
  "first-deploy",
  "failure-recovery",
  "cleanup-or-uninstall",
]) satisfies readonly SmokeStageId[];

const REQUIRED_RESULT_FEEDS = Object.freeze([
  "release-notes",
  "troubleshooting",
  "support-handoff",
]) satisfies readonly ResultFeedTarget[];

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "production installer",
    pattern: /\b(production installer|installer scripts|native package|native packages|package manager publishing)\b/i,
  },
  {
    label: "live cloud provisioning",
    pattern: /\b(provision live cloud|live cloud resources|remote resource provisioning|tenant provisioning|real first deploy)\b/i,
  },
  {
    label: "production auth",
    pattern: /\b(production auth|mint production|seed tokens?|persist credentials?|store secrets?)\b/i,
  },
  {
    label: "customer environment scan",
    pattern: /\b(scan customer environments?|customer environment scans?)\b/i,
  },
  {
    label: "uninstall cleanup implementation",
    pattern: /\b(implement uninstall cleanup|uninstall cleanup against live resources|cleanup runner implementation)\b/i,
  },
]);

const saasStages = Object.freeze([
  stage("preflight", "required", ["saas-account-preflight-fixture"], ["identity-account-mock"], "saas.preflight"),
  stage("auth-seed", "mocked", ["workspace-seed-fixture"], ["identity-account-mock"], "saas.auth-seed"),
  stage("first-project", "required", ["starter-project-fixture"], ["provider-catalog-mock"], "saas.first-project"),
  stage("first-deploy", "mocked", ["mock-deploy-result-fixture"], ["deploy-runner-mock"], "saas.first-deploy"),
  stage("failure-recovery", "required", ["retry-diagnostics-fixture"], ["support-ticket-mock"], "saas.failure-recovery"),
  stage(
    "cleanup-or-uninstall",
    "documented-boundary",
    ["account-cleanup-request-fixture"],
    ["billing-signup-mock"],
    "saas.cleanup-or-uninstall",
  ),
]) satisfies readonly BootstrapLaunchSmokeStage[];

const selfHostStages = Object.freeze([
  stage("preflight", "required", ["seed-yard-prereq-fixture"], ["provenance-verifier-mock"], "self-host.preflight"),
  stage("auth-seed", "required", ["identity-handoff-fixture"], ["identity-handoff-mock"], "self-host.auth-seed"),
  stage("first-project", "required", ["yard-project-seed-fixture"], ["cloud-provider-mock"], "self-host.first-project"),
  stage("first-deploy", "mocked", ["offline-deploy-result-fixture"], ["cloud-provider-mock"], "self-host.first-deploy"),
  stage("failure-recovery", "required", ["bootstrap-attempt-recovery-fixture"], ["support-ticket-mock"], "self-host.failure-recovery"),
  stage("cleanup-or-uninstall", "documented-boundary", ["seed-yard-cleanup-ledger-fixture"], ["upgrade-runner-mock"], "self-host.cleanup-or-uninstall"),
]) satisfies readonly BootstrapLaunchSmokeStage[];

const localStages = Object.freeze([
  stage("preflight", "required", ["local-runtime-prereq-fixture"], ["runtime-checker-mock"], "local.preflight"),
  stage("auth-seed", "mocked", ["local-dev-auth-fixture"], ["identity-account-mock"], "local.auth-seed"),
  stage("first-project", "required", ["sample-project-fixture"], ["provider-catalog-mock"], "local.first-project"),
  stage("first-deploy", "mocked", ["local-mock-deploy-fixture"], ["deploy-runner-mock"], "local.first-deploy"),
  stage("failure-recovery", "required", ["local-failure-diagnostics-fixture"], ["support-ticket-mock"], "local.failure-recovery"),
  stage("cleanup-or-uninstall", "documented-boundary", ["local-cleanup-manifest-fixture"], ["runtime-checker-mock"], "local.cleanup-or-uninstall"),
]) satisfies readonly BootstrapLaunchSmokeStage[];

export const BOOTSTRAP_LAUNCH_SMOKE_MATRIX: BootstrapLaunchSmokeMatrix = Object.freeze({
  issue: "HOBO-501",
  phase: "M1",
  goal:
    "Prove the launch smoke evidence matrix for SaaS, self-host, and local/dev bootstrap paths without implementing production installer, auth, deploy, or cleanup runtime.",
  paths: Object.freeze([
    {
      id: "saas-bootstrap",
      primaryUser: "App developer",
      fixtures: Object.freeze([
        "saas-account-preflight-fixture",
        "workspace-seed-fixture",
        "starter-project-fixture",
        "mock-deploy-result-fixture",
        "retry-diagnostics-fixture",
        "account-cleanup-request-fixture",
      ]),
      mockedBoundaries: Object.freeze([
        "identity-account-mock",
        "provider-catalog-mock",
        "deploy-runner-mock",
        "billing-signup-mock",
        "support-ticket-mock",
      ]),
      unsupportedStates: Object.freeze([
        "production auth implementation",
        "billing signup",
        "tenant provisioning",
        "live deploy execution",
        "cleanup runner implementation",
      ]),
      firstProjectContract: "Starter workspace, project id, selected template, and provider capability fixture.",
      firstDeployContract: "Mock deploy result with status, logs pointer, rollback hint, and unsupported-state label.",
      seedAuth: {
        credentialSource: "SaaS workspace seed fixture",
        allowedScopes: Object.freeze(["workspace.bootstrap", "project.create"]),
        ttlSeconds: 1800,
        auditEvent: "SaasBootstrapSeedObserved",
        identityHandoff: "mocked identity account handoff",
        noAmbientCloudKey: true,
        zeroEgressMode: false,
      },
      stages: saasStages,
    },
    {
      id: "self-host-bootstrap",
      primaryUser: "DevOps operator",
      fixtures: Object.freeze([
        "seed-yard-prereq-fixture",
        "offline-provenance-bundle-fixture",
        "identity-handoff-fixture",
        "yard-project-seed-fixture",
        "offline-deploy-result-fixture",
        "bootstrap-attempt-recovery-fixture",
        "seed-yard-cleanup-ledger-fixture",
      ]),
      mockedBoundaries: Object.freeze([
        "cloud-provider-mock",
        "identity-handoff-mock",
        "provenance-verifier-mock",
        "upgrade-runner-mock",
        "support-ticket-mock",
      ]),
      unsupportedStates: Object.freeze([
        "real seed-token minting",
        "control-plane installation",
        "live cloud provisioning",
        "upgrade runner implementation",
        "ambient cloud credentials",
      ]),
      firstProjectContract: "Seed Yard project record with imported provenance and target resource-state fixture.",
      firstDeployContract: "Offline deploy smoke result proving target shape without running provider calls.",
      seedAuth: {
        credentialSource: "single-use operator bootstrap secret fixture",
        allowedScopes: Object.freeze(["bootstrap.seed-yard", "identity.handoff"]),
        ttlSeconds: 3600,
        auditEvent: "BootstrapSeedCredentialObserved",
        identityHandoff: "real Identity handoff boundary fixture, not a minted production token",
        noAmbientCloudKey: true,
        zeroEgressMode: true,
      },
      stages: selfHostStages,
    },
    {
      id: "local-dev-bootstrap",
      primaryUser: "App developer",
      fixtures: Object.freeze([
        "local-runtime-prereq-fixture",
        "local-dev-auth-fixture",
        "sample-project-fixture",
        "local-mock-deploy-fixture",
        "local-failure-diagnostics-fixture",
        "local-cleanup-manifest-fixture",
      ]),
      mockedBoundaries: Object.freeze([
        "runtime-checker-mock",
        "identity-account-mock",
        "provider-catalog-mock",
        "deploy-runner-mock",
        "support-ticket-mock",
      ]),
      unsupportedStates: Object.freeze([
        "production local runtime parity claim",
        "remote resource provisioning",
        "secret collection",
        "customer data scans",
        "uninstall cleanup execution",
      ]),
      firstProjectContract: "Local sample app, generated config fixture, and project manifest.",
      firstDeployContract: "Mock deploy shape with local log bundle and explicit simulated-provider label.",
      seedAuth: {
        credentialSource: "local dev auth fixture",
        allowedScopes: Object.freeze(["local.bootstrap", "project.create"]),
        ttlSeconds: 900,
        auditEvent: "LocalBootstrapAuthObserved",
        identityHandoff: "local mocked identity boundary",
        noAmbientCloudKey: true,
        zeroEgressMode: true,
      },
      stages: localStages,
    },
  ]),
  resultFeeds: Object.freeze([
    {
      target: "release-notes",
      owner: "V1 Release Program & Cutline",
      sourceResultIds: Object.freeze(["saas.first-deploy", "self-host.first-deploy", "local.first-deploy"]),
      entries: Object.freeze([
        "SaaS bootstrap launch notes may claim mocked first project and first deploy smoke shape only.",
        "Self-host bootstrap launch notes must call out seed Yard, Identity handoff, and air-gap evidence limits.",
        "Local/dev bootstrap launch notes must label simulated provider behavior and unsupported OS/tool states.",
      ]),
    },
    {
      target: "troubleshooting",
      owner: "Support Workflow",
      sourceResultIds: Object.freeze(["saas.failure-recovery", "self-host.failure-recovery", "local.failure-recovery"]),
      entries: Object.freeze([
        "Troubleshooting uses path, stage, fixture id, unsupported state, and retry classification.",
        "Unsupported states are customer-safe labels, not live remediation instructions.",
      ]),
    },
    {
      target: "support-handoff",
      owner: "Support Workflow",
      sourceResultIds: Object.freeze(["saas.preflight", "self-host.auth-seed", "local.preflight"]),
      entries: Object.freeze([
        "Support handoff includes setup-stage diagnostics, mocked boundary labels, and owner routes.",
        "Support receives no secrets, no customer environment scan output, and no live deploy artifact.",
      ]),
    },
  ]),
  scopeIn: Object.freeze([
    "Record launch smoke matrix evidence for SaaS, self-host, and local/dev bootstrap paths.",
    "Name required fixtures, mocked boundaries, unsupported states, first project shape, first deploy shape, failure recovery, and cleanup/uninstall boundaries.",
    "Feed accepted smoke results into release notes, troubleshooting, and support handoff inputs.",
  ]),
  scopeOut: Object.freeze([
    "Production installer scripts, native packages, package manager publishing, or binary delivery.",
    "Live cloud provisioning, tenant provisioning, production auth, real deploy execution, or seed-token minting.",
    "Secret persistence, customer environment scanning, uninstall cleanup runtime, or support ticket workflow implementation.",
  ]),
  designRefs: Object.freeze([
    "docs/design/bootstrap-installer.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/walkthrough.md",
    "docs/design/dogfood-yard.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/01-architecture-core.md#adr-0092",
    "docs/design/adr/07-portability-extensibility.md#adr-0036",
    "docs/design/adr/02-identity-security.md#adr-0008",
  ]),
});

export function validateBootstrapLaunchSmokeMatrix(target: Partial<MutableBootstrapLaunchSmokeMatrix>): ValidationResult {
  const errors: string[] = [];
  const paths = target.paths ?? [];
  const resultFeeds = target.resultFeeds ?? [];

  for (const pathId of REQUIRED_PATH_IDS) {
    const path = paths.find((candidate) => candidate.id === pathId);
    if (!path) {
      errors.push(`Missing bootstrap path: ${pathId}`);
      continue;
    }

    if (!path.firstProjectContract) {
      errors.push(`Missing first project shape: ${pathId}`);
    }
    if (!path.firstDeployContract) {
      errors.push(`Missing first deploy shape: ${pathId}`);
    }
    if ((path.fixtures ?? []).length === 0) {
      errors.push(`Missing fixtures: ${pathId}`);
    }
    if ((path.mockedBoundaries ?? []).length === 0) {
      errors.push(`Missing mocked boundaries: ${pathId}`);
    }
    if ((path.unsupportedStates ?? []).length === 0) {
      errors.push(`Missing unsupported states: ${pathId}`);
    }

    for (const stageId of REQUIRED_STAGE_IDS) {
      const stage = path.stages?.find((candidate) => candidate.id === stageId);
      if (!stage) {
        errors.push(`Missing stage ${stageId}: ${pathId}`);
        continue;
      }
      if ((stage.fixtureIds ?? []).length === 0) {
        errors.push(`Missing fixture binding: ${pathId}/${stageId}`);
      }
      if ((stage.mockedBoundaryIds ?? []).length === 0) {
        errors.push(`Missing mocked boundary binding: ${pathId}/${stageId}`);
      }
      if (!stage.resultId) {
        errors.push(`Missing result id: ${pathId}/${stageId}`);
      }
    }
  }

  for (const feedTarget of REQUIRED_RESULT_FEEDS) {
    const feed = resultFeeds.find((candidate) => candidate.target === feedTarget);
    if (!feed) {
      errors.push(`Missing result feed: ${feedTarget}`);
      continue;
    }
    if ((feed.sourceResultIds ?? []).length === 0 || (feed.entries ?? []).length === 0) {
      errors.push(`Result feed lacks sources or entries: ${feedTarget}`);
    }
  }

  for (const scopeItem of target.scopeIn ?? []) {
    for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
      if (forbidden.pattern.test(scopeItem)) {
        errors.push(`Scope creep rejected: ${forbidden.label}`);
      }
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

export function summarizeBootstrapLaunchEvidence(matrix: BootstrapLaunchSmokeMatrix): BootstrapLaunchEvidenceSummary {
  const feedTargets = REQUIRED_RESULT_FEEDS.filter((target) => matrix.resultFeeds.some((feed) => feed.target === target));

  return Object.freeze({
    feedTargets,
    releaseNotes: feedEntries(matrix, "release-notes"),
    troubleshooting: feedEntries(matrix, "troubleshooting"),
    supportHandoff: feedEntries(matrix, "support-handoff"),
  });
}

export function classifyBootstrapLaunchSmokeWork(description: string): WorkClassification {
  const normalized = description.toLowerCase();

  if (/\b(production installer|native binary|native package|package manager)\b/.test(normalized)) {
    return { owner: "Bootstrap Installer Production Implementation", inScope: false };
  }
  if (/\b(release notes|launch claims|cutline|go\/no-go)\b/.test(normalized)) {
    return { owner: "V1 Release Program & Cutline", inScope: false };
  }
  if (/\b(support|ticket|troubleshooting|escalation)\b/.test(normalized)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\b(dogfood|yard|seed handover|seed yard)\b/.test(normalized)) {
    return { owner: "Dogfood Yard", inScope: false };
  }
  if (/\b(live cloud|provider provisioning|real deploy|tenant provisioning)\b/.test(normalized)) {
    return { owner: "Providers/IaC/Deploy Runtime", inScope: false };
  }

  return { owner: "Bootstrap Installer Launch Smoke Matrix", inScope: true };
}

export function cloneMutableBootstrapLaunchSmokeMatrix(): MutableBootstrapLaunchSmokeMatrix {
  return {
    ...BOOTSTRAP_LAUNCH_SMOKE_MATRIX,
    paths: BOOTSTRAP_LAUNCH_SMOKE_MATRIX.paths.map((path) => ({ ...path })),
    resultFeeds: BOOTSTRAP_LAUNCH_SMOKE_MATRIX.resultFeeds.map((feed) => ({ ...feed })),
    scopeIn: [...BOOTSTRAP_LAUNCH_SMOKE_MATRIX.scopeIn],
  };
}

function stage(
  id: SmokeStageId,
  disposition: StageDisposition,
  fixtureIds: readonly string[],
  mockedBoundaryIds: readonly string[],
  resultId: string,
): BootstrapLaunchSmokeStage {
  return Object.freeze({
    id,
    disposition,
    fixtureIds: Object.freeze([...fixtureIds]),
    mockedBoundaryIds: Object.freeze([...mockedBoundaryIds]),
    resultId,
    proves: `${id} has launch smoke fixture evidence and explicit mocked-boundary ownership.`,
  });
}

function feedEntries(matrix: BootstrapLaunchSmokeMatrix, target: ResultFeedTarget): readonly string[] {
  return matrix.resultFeeds.find((feed) => feed.target === target)?.entries ?? [];
}
