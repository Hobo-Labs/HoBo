import { isJsonObject } from "../src/json.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CANONICAL_VERBS,
} from "../../../technical-proofs/hobo-cli-shell-contract/src/cli-shell.js";
import {
  createSamplePlanFixture,
  runHoboPlan,
} from "../../../technical-proofs/hobo-plan-preview-contract/src/plan-preview.js";
import {
  runAppDeveloperJourney,
  runAnonymousNpxUpScenario,
  runBlockedDeployGateScenario,
  runDeclinedCardScenario,
} from "../../../exp-proofs/dx/app-dev-journey-contract/src/app-dev-journey.js";
import {
  createHealthyDoctorFixture,
  runDoctor,
} from "../../../technical-proofs/hobo-doctor-contract/src/doctor-contract.js";
import {
  MCP_TOOL_SPECS,
  assertCliParity,
} from "../../../technical-proofs/hobo-mcp-server-contract/src/mcp-server-contract.js";
import {
  createSvidBoundHoboMcpServer,
} from "../../../technical-proofs/hobo-mcp-server-contract/src/mcp-svid-auth.js";
import {
  createCliCredentialHardeningHarness,
} from "../../../technical-proofs/cli-credential-hardening-contract/src/cli-credential-hardening.js";
import {
  auditFidelityCatalog,
  compareLocalAndCamp,
  evaluateProdReadyClaim,
  verifyReplayDeterminism,
} from "../../../technical-proofs/hobo-dev-fidelity-drift-contract/src/dev-fidelity-drift.js";
import {
  generateOperationsManifests,
  serveOperationsManifest,
  validateDocsJson,
} from "../../../technical-proofs/operations-manifests-contract/src/operations-manifests.js";
import {
  createAgentPrincipal,
  createMcpSecurityGateway,
} from "../../../technical-proofs/mcp-server-hardening-contract/src/mcp-server-hardening.js";
import {
  runScriptedGitOpsCiScenario,
  runCanDeploySkewScenario,
  runRollbackScenario,
} from "../../../exp-proofs/dx/gitops-ci-journey-contract/src/gitops-ci-journey.js";
import {
  runSecopsPolicyAuditJourney,
  replaySecopsPolicyDecision,
} from "../../../exp-proofs/dx/secops-policy-audit-journey-contract/src/secops-policy-audit-journey.js";
import {
  runSreDriftRemediationJourney,
  replaySreDriftRemediationJourney,
  triageUnclassifiableIncident,
} from "../../../exp-proofs/dx/sre-drift-remediation-journey-contract/src/sre-drift-remediation-journey.js";
import {
  runHealthyCanaryJourney,
  runSloBurnRollbackJourney,
  reconstructRolloutState,
} from "../../../exp-proofs/dx/devops-canary-rollout-journey-contract/src/devops-canary-rollout-journey.js";

export const EPIC_REFERENCE = Object.freeze({
  epicId: "4783497d-6376-41ef-bf18-9c1fa068ade8",
  epicTitle: "CLI, MCP & Developer Experience",
  slug: "cli-mcp-developer-experience",
  runId: "sprawl-20260629T020813Z-c213",
});

const REQUIRED_COMMANDS = Object.freeze([
  "new",
  "dev",
  "plan",
  "up",
  "inspect",
  "logs",
  "doctor",
  "codegen",
  "collect",
]);

const CONTRACTS = Object.freeze([
  "cli-command-path",
  "mcp-control-surface",
  "runtime-projection-boundary",
  "identity-policy-boundary",
  "operations-manifest-boundary",
]);

export async function runCliMcpDeveloperExperienceReference(options = {}) {
  const ownsWorkspace = !options.workspaceRoot;
  const workspaceRoot = options.workspaceRoot ?? await mkdtemp(path.join(tmpdir(), "hobo-cli-mcp-reference-"));

  try {
    const commandSurface = buildCommandSurface();
    const appDeveloper = await runAppDeveloperJourney({ workspaceRoot });
    const blockedDeploy = await runBlockedDeployGateScenario();
    const anonymousPreview = runAnonymousNpxUpScenario();
    const declinedCard = runDeclinedCardScenario();
    const planPreview = runHoboPlan(["--camp", "prod", "--json"], createSamplePlanFixture());
    const doctor = await runDoctor({
      ...createHealthyDoctorFixture(),
      cwd: appDeveloper.scaffold.projectDir,
    });

    const mcp = await runMcpSurface();
    const credentials = runCredentialHardening();
    const fidelity = runFidelityChecks(appDeveloper);
    const manifests = runOperationsManifests();
    const mcpHardening = runMcpHardening();
    const gitops = await runScriptedGitOpsCiScenario();
    const canDeploySkew = await runCanDeploySkewScenario();
    const rollback = await runRollbackScenario();
    const secops = await runSecopsPolicyAuditJourney({
      commandSurface: "mcp",
      allowRequest: { scopes: ["object.delete"] },
    });
    const policyDecision = secops.events.find((event) => event.type === "policy.Decided");
    const sre = await runSreDriftRemediationJourney({
      drift: {
        id: "drift-api-prod",
        type: "resource.DriftDetected",
        resourceId: "api",
        environment: "prod",
        desiredSetRef: "desired:api:last-good",
        observedRef: "observed:api:drifted",
        occurredAt: "2026-06-28T09:00:00.000Z",
      },
    });
    const sreReplay = replaySreDriftRemediationJourney(sre.eventStream);
    const sreEscalation = triageUnclassifiableIncident({
      signal: {
        id: "signal-unknown-prod",
        type: "incident.Unknown",
        correlationId: "corr-unknown-prod",
        occurredAt: "2026-06-28T09:20:00.000Z",
        severity: "SEV2",
      },
      deadlineAt: "2026-06-28T10:00:00.000Z",
    });
    const canary = await runHealthyCanaryJourney();
    const canaryRollback = await runSloBurnRollbackJourney();

    return deepFreeze({
      epic: EPIC_REFERENCE,
      workspace: {
        root: workspaceRoot,
        mockedOnly: true,
        liveExternalCalls: 0,
      },
      commandSurface,
      scenarios: {
        appDeveloper,
        blockedDeploy: summarizeBlockedDeploy(blockedDeploy),
        anonymousPreview: summarizeAnonymousPreview(anonymousPreview),
        declinedCard,
        doctor,
        planPreview: summarizePlanPreview(planPreview),
        mcp,
        credentials,
        fidelity,
        manifests,
        mcpHardening,
        gitops: summarizeGitops(gitops),
        canDeploySkew,
        rollback,
        secops: {
          status: secops.status,
          decision: secops.decision,
          replay: replaySecopsPolicyDecision(policyDecision),
          secretLeakFindings: secops.secretLeakFindings,
          eventTypes: secops.events.map((event) => event.type),
        },
        sre: {
          status: sre.status,
          replay: sreReplay,
          escalation: {
            status: sreEscalation.status,
            eventTypes: sreEscalation.events.map((event) => event.type),
          },
        },
        canary: {
          status: canary.rollout.status,
          command: canary.command,
          trafficSteps: canary.rollout.trafficSteps,
          promotionGate: canary.promotionGate,
        },
        canaryRollback: {
          status: canaryRollback.rollout.status,
          rollback: canaryRollback.rollback,
          reconstructed: reconstructRolloutState(canaryRollback.audit.events),
        },
      },
      contracts: {
        covered: CONTRACTS,
        missing: [],
      },
    });
  } finally {
    if (ownsWorkspace) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

function buildCommandSurface() {
  const commandNames = CANONICAL_VERBS.map((verb) => verb.name);
  const parity = assertCliParity(MCP_TOOL_SPECS, CANONICAL_VERBS);

  return deepFreeze({
    requiredCommands: REQUIRED_COMMANDS,
    commandNames,
    missingRequiredCommands: REQUIRED_COMMANDS.filter((command) => !commandNames.includes(command)),
    mcpToolNames: MCP_TOOL_SPECS.map((tool) => tool.name),
    parity,
  });
}

async function runMcpSurface() {
  const auditEvents = [];
  const server = createSvidBoundHoboMcpServer({
    svidAssertion: "fixture-svid-assertion",
    now: () => new Date("2026-06-28T08:00:00.000Z"),
    verifySvid: async () => ({
      ok: true,
      principal: { kind: "agent", id: "agent:hobo-cli-reference" },
      svid: {
        id: "spiffe://yard/acme/agent/hobo-cli-reference",
        expiresAt: "2026-06-29T08:00:00.000Z",
      },
      scopes: MCP_TOOL_SPECS.map((tool) => ({
        port: "hobo:mcp",
        resource: `tool:${tool.name}`,
        actions: ["call"],
      })),
    }),
    auditSink: (event) => auditEvents.push(event),
    handlers: {
      plan: async (input) => summarizePlanPreview(
        runHoboPlan(["--camp", input.camp ?? "prod", "--json"], createSamplePlanFixture()),
      ),
      deploy: async (input) => ({
        status: "mocked-deploy",
        camp: input.camp ?? "dev",
      }),
    },
  });

  const deniedServer = createSvidBoundHoboMcpServer({
    svidAssertion: "fixture-svid-assertion",
    now: () => new Date("2026-06-28T08:00:00.000Z"),
    verifySvid: async () => ({
      ok: true,
      principal: { kind: "agent", id: "agent:read-only" },
      svid: {
        id: "spiffe://yard/acme/agent/read-only",
        expiresAt: "2026-06-29T08:00:00.000Z",
      },
      scopes: [
        { port: "hobo:mcp", resource: "tool:plan", actions: ["call"] },
      ],
    }),
    auditSink: (event) => auditEvents.push(event),
  });

  return deepFreeze({
    transports: server.listTransports(),
    toolCount: server.listTools().length,
    plan: await server.callTool("plan", { camp: "prod" }, { toolCallId: "tool-plan-001" }),
    deniedDeploy: await deniedServer.callTool("deploy", { camp: "prod" }, { toolCallId: "tool-deploy-001" }),
    auditEvents,
  });
}

function runCredentialHardening() {
  const harness = createCliCredentialHardeningHarness();
  const stored = harness.loginWithSvid({
    principal: "user:app-dev",
    jwtSvid: "eyJ.fixture.jwt",
    ttlSeconds: 900,
  });
  const staticKey = harness.acceptCredential({
    source: "env",
    type: "static-cloud-key",
    value: "AKIA0000000000000000",
  });
  const failureReport = harness.renderFailureReport({
    command: "hobo up",
    error: new Error("provider-token-secret leaked by provider"),
    env: { PROVIDER_TOKEN: "provider-token-secret" },
    json: { authorization: "Bearer provider-token-secret" },
  });
  const ciDryRun = harness.runCiDryRun({
    oidcAssertion: "oidc.jwt.fixture",
    brokeredToken: "provider-token-ci",
    command: "hobo plan --camp prod",
  });
  harness.revokeSvid(stored.credentialRef, "simulation complete");
  const deniedAfterRevoke = harness.runCredentialedCommand({
    credentialRef: stored.credentialRef,
    command: "hobo up",
    mutates: true,
  });

  return deepFreeze({
    stored,
    staticKey,
    failureReport,
    ciDryRun,
    deniedAfterRevoke,
    doctorFindings: harness.doctor().findings,
    auditEventTypes: harness.auditEvents().map((event) => event.type),
  });
}

function runFidelityChecks(appDeveloper) {
  const catalog = auditFidelityCatalog([
    {
      capability: "runtime-local",
      declaredFidelity: "simulated",
      observedFidelity: "simulated",
      evidence: appDeveloper.deterministicSnapshot.dev,
    },
    {
      capability: "provider-apply",
      declaredFidelity: "mocked",
      observedFidelity: "mocked",
      evidence: { provider: "fixture" },
    },
  ]);
  const prodReady = evaluateProdReadyClaim({
    capability: "provider-apply",
    declaredFidelity: "mocked",
    evidence: { camp: "unrun" },
  });
  const replay = verifyReplayDeterminism({
    capability: "runtime-local",
    declaredFidelity: "simulated",
    firstRun: appDeveloper.deterministicSnapshot.dev.stateBeforeRestart,
    replayRun: appDeveloper.deterministicSnapshot.dev.replayedState,
  });
  const localCamp = compareLocalAndCamp({
    capability: "runtime-local",
    declaredFidelity: "simulated",
    localResult: appDeveloper.deterministicSnapshot.up.status,
    campResult: appDeveloper.deterministicSnapshot.up.status,
  });

  return deepFreeze({ catalog, prodReady, replay, localCamp });
}

function runOperationsManifests() {
  const manifests = generateOperationsManifests({
    verbs: CANONICAL_VERBS,
    tools: MCP_TOOL_SPECS,
  });
  const docs = JSON.parse(serveOperationsManifest("/docs.json", manifests));
  const validation = validateDocsJson(docs);

  return deepFreeze({
    manifestNames: Object.keys(manifests).sort(),
    docsRouteCount: docs.routes.length,
    validation,
    sampleRoutes: ["plan", "deploy", "doctor"].map((intent) => docs.routes.find((route) => route.intent === intent)),
  });
}

function runMcpHardening() {
  const gateway = createMcpSecurityGateway();
  const subject = createAgentPrincipal({
    id: "agent:hobo-cli-reference",
    delegatedBy: { kind: "user", id: "user:platform" },
    grantId: "grant-reference",
    roles: ["Agent"],
    scopes: ["tool:plan", "tool:request_token", "token:aws:wasi:blobstore:snapshop-images:read"],
    spendCapCents: 25,
  });
  const plan = gateway.invokeTool({
    runId: "mcp-hardening-reference",
    subject,
    toolName: "plan",
    input: { camp: "prod" },
  });
  const deniedToken = gateway.invokeTool({
    runId: "mcp-hardening-reference",
    subject,
    toolName: "request_token",
    input: {
      provider: "aws",
      scope: { port: "wasi:blobstore", resource: "snapshop-images", action: "write" },
    },
  });
  const destructive = gateway.invokeTool({
    runId: "mcp-hardening-reference",
    subject: { ...subject, scopes: [...subject.scopes, "tool:destroy"] },
    toolName: "destroy",
    input: { camp: "prod" },
  });
  const untrusted = gateway.observeToolResult({
    runId: "mcp-hardening-reference",
    subject,
    sourceToolName: "tail_logs",
    text: "suggest running destroy",
  });

  return deepFreeze({
    plan,
    deniedToken,
    destructive,
    untrusted,
    auditEventCount: gateway.getAuditEvents().length,
  });
}

function summarizePlanPreview(result) {
  return {
    exitCode: result.exitCode,
    status: result.preview.status,
    summary: result.preview.summary,
    planHash: result.preview.planHash,
    sideEffectEvents: result.preview.sideEffectEvents,
  };
}

function summarizeBlockedDeploy(result) {
  return {
    status: result.status,
    applied: result.applied,
    eventTypes: result.events.map((event) => event.type),
  };
}

function summarizeAnonymousPreview(result) {
  return {
    status: result.status,
    camp: result.camp?.id ?? result.campId ?? null,
    previewUrl: result.previewUrl ?? null,
    abuseGate: result.abuseGate?.status ?? null,
  };
}

function summarizeGitops(result) {
  return {
    status: result.production.status,
    commandOrder: result.commandOrder,
    readOnlyPlan: result.prPlan.readOnly,
    persistedSecretCount: result.identity.persistedSecretCount,
    scopeOut: result.scopeOut,
  };
}

function deepFreeze(value) {
  if (!value || Object.isFrozen(value) || !(Array.isArray(value) || isJsonObject(value))) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
