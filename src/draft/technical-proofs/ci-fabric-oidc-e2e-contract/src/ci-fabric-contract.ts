import { isJsonObject } from "./json.js";
export const CI_FABRIC_SCHEMA = "hobo.ciFabric/v1";

const REQUIRED_PR_CHECKS = Object.freeze(["build", "typecheck", "lint", "unit", "conformance"]);
const REQUIRED_PR_COMMANDS = Object.freeze([
  // Mirrors the enforced PR gate in .github/workflows/hobo-ci.yml; the
  // production guard is packages/ci-guard/bin/assert-ci-contract.ts.
  // scripts/validate-traceability.ts was descoped from the blocking gate:
  // traceability is covered by docs:design-lint + konsistent.
  "pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
  "pnpm run lint:code",
  "pnpm agent:check -- --base=origin/main",
  "pnpm exec turbo run build typecheck lint test:unit test:schema test:contract:consumer",
  "pnpm run build:packages",
]);
const REQUIRED_COVERAGE = Object.freeze([
  "pr.full-suite-blocking",
  "e2e.oidc-secretless",
  "e2e.hello-bindle-live-url",
  "e2e.teardown-and-sweeper",
  "e2e.cost-gated",
  "e2e.quarantine-nonblocking",
  "cache.wasm-oci-artifacts",
]);
const FORBIDDEN_CLOUD_ACTION_PREFIXES = Object.freeze(["iam:", "billing:", "secrets:", "resources:admin"]);
const SECRET_REFERENCE_PATTERN = /\$\{\{\s*secrets\./i;

export class CiFabricContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CiFabricContractError";
    this.code = code;
    this.details = details;
  }
}

export function createHoboCiFabricContract(overrides = {}) {
  const base = {
    schema: CI_FABRIC_SCHEMA,
    workflow: {
      name: "hobo-ci",
      path: ".github/workflows/hobo-ci.yml",
      triggers: {
        pullRequest: true,
        schedule: "17 3 * * 1",
        workflowDispatch: true,
      },
      pullRequestGate: {
        blocksPullRequest: true,
        requiredChecks: [...REQUIRED_PR_CHECKS],
        commands: [...REQUIRED_PR_COMMANDS],
      },
      artifactCache: {
        entries: [
          {
            kind: "wasm",
            path: "~/.cache/hobo/wasm",
            keyFrom: ["package-lock.json", "src/draft/**/package.json", "wit/**/*.wit"],
          },
          {
            kind: "oci",
            path: "~/.cache/hobo/oci",
            keyFrom: ["package-lock.json", "src/draft/**/package.json", "src/draft/**/src/**"],
          },
        ],
      },
    },
    e2e: {
      name: "hello-bindle-e2e",
      fixture: "examples/hello-bindle",
      permissions: {
        contents: "read",
        "id-token": "write",
      },
      env: {},
      gatedBy: [
        { kind: "pull-request-label", label: "hobo/e2e" },
        { kind: "schedule", cron: "17 3 * * 1" },
        { kind: "manual" },
      ],
      auth: {
        mode: "oidc-federation",
        audience: "hobo:sandbox-cloud",
        tokenBroker: "https://sandbox.yard.example/.well-known/hobo/oidc/token",
        forbidsStoredSecrets: true,
        allowedTrustDomain: "spiffe://sandbox.yard/ci/github/tyler-r-kendrick/hobo",
        cloudRole: {
          name: "hobo-ci-hello-bindle-e2e",
          allowedActions: ["deployments:create", "deployments:read", "deployments:delete"],
          resourceSelector: {
            fixture: "hello-bindle",
            runLabel: "hobo.dev/github-run-id",
          },
        },
      },
      deploy: {
        command: "npx hobo up examples/hello-bindle --camp sandbox-ci --wait --json",
        asserts: ["live-url.https", "live-url.http-2xx", "fixture.hello-bindle"],
      },
      teardown: {
        command: "npx hobo down examples/hello-bindle --camp sandbox-ci --yes",
        always: true,
        orphanSweeper: {
          enabled: true,
          maxAgeMinutes: 60,
          selector: "hobo.dev/fixture=hello-bindle",
        },
      },
      quarantine: {
        label: "hobo/e2e-quarantine",
        lane: "hello-bindle-e2e-quarantine",
        continueOnError: true,
        blocksPullRequest: false,
      },
    },
  };

  return deepFreeze(deepMerge(base, overrides));
}

export function validateCiFabricContract(contract) {
  const violations = [];
  const workflow = contract?.workflow ;
  const pullRequestGate = workflow.pullRequestGate ;
  const e2e = contract?.e2e ;

  if (contract?.schema !== CI_FABRIC_SCHEMA) {
    violations.push({
      code: "schema.unsupported",
      message: `expected schema ${CI_FABRIC_SCHEMA}`,
    });
  }

  validatePullRequestGate(pullRequestGate, violations);
  validateArtifactCache(workflow.artifactCache, violations);
  validateE2eGate(e2e, workflow.triggers, violations);
  validateOidc(e2e, violations);
  validateHelloBindleDeployment(e2e, violations);
  validateTeardown(e2e.teardown, violations);
  validateQuarantine(e2e.quarantine, violations);

  return deepFreeze({
    passed: violations.length === 0,
    coverage: violations.length === 0 ? [...REQUIRED_COVERAGE] : [],
    violations,
  });
}

export function assertCiFabricContract(contract) {
  const report = validateCiFabricContract(contract);
  if (!report.passed) {
    throw new CiFabricContractError(
      "ci-fabric-contract-failed",
      report.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; "),
      { violations: report.violations },
    );
  }
  return report;
}

export function shouldRunHelloBindleE2e(contract, { eventName, labels = [] } = {}) {
  const gatedBy = contract?.e2e?.gatedBy ?? [];
  const labelSet = new Set(labels);

  return gatedBy.some((gate) => {
    if (gate.kind === "schedule") {
      return eventName === "schedule";
    }
    if (gate.kind === "manual") {
      return eventName === "workflow_dispatch";
    }
    if (gate.kind === "pull-request-label") {
      return eventName === "pull_request" && labelSet.has(gate.label);
    }
    return false;
  });
}

export function simulateHelloBindleE2e(contract, { githubRunId, liveUrl, failAt } = {}) {
  assertCiFabricContract(contract);

  const runId = githubRunId ?? "local-run";
  const e2e = contract.e2e;
  const events = [];
  const token = {
    issuer: e2e.auth.tokenBroker,
    audience: e2e.auth.audience,
    subject: e2e.auth.allowedTrustDomain,
    scopes: [...e2e.auth.cloudRole.allowedActions],
    expiresInSeconds: 900,
  };
  const deployment = {
    fixture: e2e.fixture,
    runId,
    liveUrl: liveUrl ?? `https://hello-bindle.${runId}.sandbox.hobo.dev`,
  };
  const cleanup = {
    teardownAttempted: false,
    orphanSweeperRan: false,
  };
  let failure;

  events.push({
    type: "oidc.TokenRequested",
    audience: token.audience,
    subject: token.subject,
  });
  events.push({
    type: "sandbox.TokenGranted",
    role: e2e.auth.cloudRole.name,
    scopes: [...token.scopes],
  });
  events.push({
    type: "hobo.UpStarted",
    fixture: deployment.fixture,
    runId,
  });
  events.push({
    type: "hobo.LiveUrlAsserted",
    liveUrl: deployment.liveUrl,
    ok: failAt !== "assert-live-url",
  });

  if (failAt === "assert-live-url") {
    failure = {
      code: "live-url-unreachable",
      message: `${deployment.liveUrl} did not return HTTP 2xx`,
    };
  }

  cleanup.teardownAttempted = true;
  events.push({
    type: "hobo.DownStarted",
    fixture: deployment.fixture,
    runId,
  });
  cleanup.orphanSweeperRan = true;
  events.push({
    type: "hobo.OrphanSweepCompleted",
    selector: e2e.teardown.orphanSweeper.selector,
    maxAgeMinutes: e2e.teardown.orphanSweeper.maxAgeMinutes,
  });

  return deepFreeze({
    status: failure ? "failed" : "passed",
    failure,
    token,
    deployment,
    cleanup,
    events,
  });
}

function validatePullRequestGate(pullRequestGate, violations) {
  if (pullRequestGate.blocksPullRequest !== true) {
    violations.push({
      code: "pr-gate.not-blocking",
      message: "pull request gate must block on failure",
    });
  }

  const checks = new Set(pullRequestGate.requiredChecks ?? []);
  const missingChecks = REQUIRED_PR_CHECKS.filter((check) => !checks.has(check));
  if (missingChecks.length > 0) {
    violations.push({
      code: "pr-gate.missing-checks",
      message: `PR gate is missing required checks: ${missingChecks.join(", ")}`,
    });
  }

  const commands = new Set(pullRequestGate.commands ?? []);
  const missingCommands = REQUIRED_PR_COMMANDS.filter((command) => !commands.has(command));
  if (missingCommands.length > 0) {
    violations.push({
      code: "pr-gate.missing-commands",
      message: `PR gate is missing required commands: ${missingCommands.join(", ")}`,
    });
  }
}

function validateArtifactCache(artifactCache, violations) {
  const cacheKinds = new Set((artifactCache?.entries ?? []).map((entry) => entry.kind));

  if (!cacheKinds.has("wasm")) {
    violations.push({
      code: "cache.wasm.missing",
      message: "CI cache must include wasm build artifacts",
    });
  }
  if (!cacheKinds.has("oci")) {
    violations.push({
      code: "cache.oci.missing",
      message: "CI cache must include OCI build artifacts",
    });
  }
}

function validateE2eGate(e2e, triggers = {}, violations) {
  const gatedBy = e2e.gatedBy ?? [];
  const hasLabelGate = gatedBy.some((gate) => gate.kind === "pull-request-label" && gate.label);
  const hasScheduleGate = gatedBy.some((gate) => gate.kind === "schedule" && gate.cron);
  const hasManualGate = gatedBy.some((gate) => gate.kind === "manual");

  if (!hasLabelGate || !hasScheduleGate || !hasManualGate || triggers.schedule !== "17 3 * * 1") {
    violations.push({
      code: "e2e.cost-gate.missing",
      message: "hello-bindle E2E must be gated by PR label, schedule, and manual dispatch",
    });
  }
}

function validateOidc(e2e, violations) {
  if (e2e.permissions?.["id-token"] !== "write" || e2e.auth?.mode !== "oidc-federation") {
    violations.push({
      code: "oidc.missing",
      message: "E2E job must request a GitHub OIDC token for sandbox federation",
    });
  }

  if (e2e.auth?.forbidsStoredSecrets !== true) {
    violations.push({
      code: "oidc.secretless-required",
      message: "E2E auth must forbid stored cloud secrets",
    });
  }

  const secretEnvKeys = Object.entries(e2e.env )
    .filter(([key, value]) => key.includes("SECRET") || SECRET_REFERENCE_PATTERN.test(String(value)))
    .map(([key]) => key)
    .sort();
  if (secretEnvKeys.length > 0) {
    violations.push({
      code: "oidc.stored-secret",
      message: `E2E environment references stored secrets: ${secretEnvKeys.join(", ")}`,
    });
  }

  const actions = e2e.auth?.cloudRole?.allowedActions ?? [];
  const overbroadActions = actions.filter(isOverbroadCloudAction);
  if (overbroadActions.length > 0) {
    violations.push({
      code: "oidc.role.overbroad",
      message: `sandbox role grants forbidden or wildcard actions: ${overbroadActions.join(", ")}`,
    });
  }
}

function validateHelloBindleDeployment(e2e, violations) {
  const asserts = new Set(e2e.deploy?.asserts ?? []);

  if (e2e.fixture !== "examples/hello-bindle" || !e2e.deploy?.command?.includes("examples/hello-bindle")) {
    violations.push({
      code: "e2e.fixture.missing",
      message: "E2E job must deploy examples/hello-bindle",
    });
  }
  if (!asserts.has("live-url.https") || !asserts.has("live-url.http-2xx")) {
    violations.push({
      code: "e2e.live-url-assertion.missing",
      message: "E2E job must assert an HTTPS live URL returning HTTP 2xx",
    });
  }
}

function validateTeardown(teardown = {}, violations) {
  if (teardown.always !== true) {
    violations.push({
      code: "e2e.teardown.not-always",
      message: "hello-bindle teardown must run with if: always() semantics",
    });
  }
  if (teardown.orphanSweeper?.enabled !== true) {
    violations.push({
      code: "e2e.orphan-sweeper.missing",
      message: "hello-bindle E2E must include an orphan sweeper for failed runs",
    });
  }
}

function validateQuarantine(quarantine = {}, violations) {
  if (quarantine.continueOnError !== true || quarantine.blocksPullRequest !== false) {
    violations.push({
      code: "e2e.quarantine.blocks",
      message: "quarantine E2E lane must not block PR merges",
    });
  }
}

function isOverbroadCloudAction(action) {
  return action.includes("*") || FORBIDDEN_CLOUD_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? clone(base) : clone(overrides);
  }
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides === undefined ? clone(base) : clone(overrides);
  }

  const merged = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    merged[key] = deepMerge(base[key], overrides[key]);
  }
  return merged;
}

function clone(value) {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && isJsonObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value && isJsonObject(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
