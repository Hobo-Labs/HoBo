import { isJsonString, isJsonObject } from "../src/json.js";
import { createHash } from "node:crypto";

import { buildSignedAuthManifestEnvelope } from "../../../technical-proofs/hobo-auth-json-contract/src/auth-json.js";
import {
  createCliCredentialHardeningHarness,
} from "../../../technical-proofs/cli-credential-hardening-contract/src/cli-credential-hardening.js";
import {
  createSvidBoundHoboMcpServer,
  toolCapabilityFor,
} from "../../../technical-proofs/hobo-mcp-server-contract/src/mcp-svid-auth.js";
import {
  MCP_TOOL_SPECS,
} from "../../../technical-proofs/hobo-mcp-server-contract/src/mcp-server-contract.js";
import {
  createAgentPrincipal,
  createMcpSecurityGateway,
} from "../../../technical-proofs/mcp-server-hardening-contract/src/mcp-server-hardening.js";
import {
  createTokenBroker,
} from "../../../technical-proofs/token-broker-skeleton-contract/src/token-broker-skeleton.js";

export const EPIC_REFERENCE = Object.freeze({
  issueId: "HOBO-636",
  slug: "stage-gate-s3-agent-mcp-brokered-deploy",
  journey: "J2",
  fixture: "examples/hello-bindle",
  camp: "s2-sandbox",
  runId: "w3-h636-7f2a",
});

const CONTRACTS = Object.freeze([
  "j2-mcp-journey",
  "brokered-token-audit",
  "agent-guardrail-gate",
  "credential-audit-retention",
]);

const J2_TOOL_SEQUENCE = Object.freeze([
  "list_templates",
  "new",
  "plan",
  "request_token",
  "deploy",
  "inspect_run",
  "tail_logs",
]);

const ALLOW_SCOPE = Object.freeze([
  { port: "compute", resource: "hello-bindle.api", actions: ["deploy", "read"] },
]);

const STATIC_SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /sk_live_[0-9a-zA-Z]{16,}/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /"apiKey"\s*:\s*"[A-Za-z0-9+/=_-]{20,}"/,
];

export async function runStageGateS3Drill(options = {}) {
  const eventStore = createEventStore();
  const auditSink = (event) => eventStore.append(event);
  const now = options.now ?? (() => new Date("2026-07-01T12:00:00.000Z"));
  let sequence = 0;
  const idFactory = (prefix) => `${prefix}-${++sequence}`;

  const tokenBroker = createTokenBroker({
    registry: fixtureRegistry(),
    now,
    idFactory,
    eventSink: auditSink,
    flowHandlers: {
      "oidc-federation": async (dispatch) => ({
        tokenRef: `broker://${dispatch.provider}/${dispatch.grantId}`,
        expiresAt: new Date(now().getTime() + 5 * 60 * 1000).toISOString(),
        stub: true,
      }),
    },
  });

  const agent = createAgentPrincipal({
    id: "agent:stage-gate-j2",
    delegatedBy: { kind: "user", id: "user:atlas" },
    grantId: "grant-j2-stage-gate",
    roles: ["Deployer"],
    scopes: J2_TOOL_SEQUENCE
      .concat(["verify"])
      .map((tool) => `tool:${tool}`),
    spendCapCents: 500,
  });

  const mcpScopes = [
    ...J2_TOOL_SEQUENCE.map((tool) => toolCapabilityFor(tool)),
    toolCapabilityFor("verify"),
    { port: "compute", resource: "hello-bindle.api", actions: ["deploy", "read"] },
  ];

  const svidAssertion = {
    id: "svid-j2-stage-gate",
    principal: agent,
    scopes: mcpScopes,
    expiresAt: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
  };

  let deployAttempts = 0;
  let verified = false;
  const runId = options.runId ?? "run-hello-bindle-j2-1";

  const mcp = createSvidBoundHoboMcpServer({
    tools: withListTemplatesTool(MCP_TOOL_SPECS),
    svidAssertion,
    verifySvid: async () => ({
      ok: true,
      principal: agent,
      scopes: mcpScopes,
      svid: svidAssertion,
    }),
    tokenBroker,
    auditSink,
    now,
    handlers: {
      list_templates: async () => ({
        templates: [
          {
            id: "template:hello-bindle",
            fixture: EPIC_REFERENCE.fixture,
            camp: EPIC_REFERENCE.camp,
          },
        ],
      }),
      new: async ({ cwd }) => ({
        bindleId: "hello-bindle",
        cwd: cwd ?? EPIC_REFERENCE.fixture,
        scaffolded: true,
      }),
      plan: async ({ camp }) => ({
        camp: camp ?? EPIC_REFERENCE.camp,
        changes: [{ resource: "hello-bindle.api", action: "create" }],
        sideEffects: false,
      }),
      deploy: async ({ camp }) => {
        deployAttempts += 1;
        if (!verified) {
          return {
            ok: false,
            code: "DEPLOY_GATE_FAILED",
            explainFailure: buildNfr017Failure(),
          };
        }
        return {
          ok: true,
          runId,
          camp: camp ?? EPIC_REFERENCE.camp,
          status: "deployed",
          liveUrl: `https://hello-bindle.${runId}.s2.hobo.dev`,
          credentialKind: "brokered-short-lived",
        };
      },
      verify: async () => {
        verified = true;
        return { ok: true, gates: ["compat.digest-pin"] };
      },
      inspect_run: async () => ({
        runId,
        timeline: [
          { phase: "plan", status: "succeeded" },
          { phase: "deploy", status: "succeeded" },
        ],
      }),
      tail_logs: async () => ({
        runId,
        complete: true,
        lines: ["hello-bindle listening on :8080"],
      }),
    },
  });

  const gateway = createMcpSecurityGateway();

  const journey = [];
  for (const tool of ["list_templates", "new", "plan", "request_token"]) {
    if (tool === "request_token") {
      journey.push(await mcp.callTool(tool, {
        requestId: "req-hello-bindle-deploy",
        provider: "s2-cloud",
        scope: { port: "compute", resource: "hello-bindle.api", action: "deploy" },
        svidScope: ALLOW_SCOPE,
      }, { toolCallId: `call-${tool}` }));
      continue;
    }
    journey.push(await mcp.callTool(tool, journeyInput(tool), { toolCallId: `call-${tool}` }));
  }

  const failedDeploy = await mcp.callTool("deploy", {
    cwd: EPIC_REFERENCE.fixture,
    camp: EPIC_REFERENCE.camp,
  }, { toolCallId: "call-deploy-1" });

  const selfCorrection = await applySelfCorrection(mcp, failedDeploy);

  const inspect = await mcp.callTool("inspect_run", { runId }, { toolCallId: "call-inspect" });
  const logs = await mcp.callTool("tail_logs", { runId }, { toolCallId: "call-logs" });

  const replay = replayJourney(eventStore.snapshot());

  const overBroadToken = await mcp.callTool("request_token", {
    requestId: "req-over-broad",
    provider: "s2-cloud",
    scope: { port: "database", resource: "shop.db", action: "admin" },
    svidScope: ALLOW_SCOPE,
  }, { toolCallId: "call-over-broad" });

  const credentialHarness = createCliCredentialHardeningHarness();
  const staticSecretAttempt = credentialHarness.acceptCredential({
    source: "agent-input",
    type: "static-aws-key",
    value: "AKIAEXAMPLESTATICKEY01",
  });

  const prodDeployBlocked = gateway.invokeTool({
    runId: "run-prod-gate",
    subject: agent,
    toolName: "deploy",
    input: { camp: "prod", cwd: EPIC_REFERENCE.fixture },
  });

  const prodDeployApproved = gateway.resolveApprovalHook({
    hookId: prodDeployBlocked.hook.id,
    approver: { kind: "user", id: "user:deploy-approver", roles: ["Deployer"] },
  });

  const traceScan = scanTraceForStaticSecrets([
    ...eventStore.snapshot(),
    failedDeploy,
    selfCorrection.verify,
    selfCorrection.deploy,
    inspect,
    logs,
  ]);

  const tokenEvents = eventStore.snapshot().filter((event) => event.type?.startsWith("token."));
  const tokenEventTypes = tokenEvents.map((event) => event.type);

  return deepFreeze({
    epic: EPIC_REFERENCE,
    workspace: {
      mockedOnly: true,
      liveExternalCalls: 0,
    },
    contracts: {
      covered: CONTRACTS,
      missing: CONTRACTS.filter((name) => !contractCovered(name, {
        journey,
        selfCorrection,
        tokenEventTypes,
        replay,
        overBroadToken,
        staticSecretAttempt,
        prodDeployBlocked,
        prodDeployApproved,
        traceScan,
      })),
    },
    scenarios: {
      journey: summarizeJourney(journey),
      failedDeploy,
      selfCorrection,
      inspect,
      logs,
      replay,
      overBroadToken,
      staticSecretAttempt,
      prodDeployBlocked,
      prodDeployApproved,
      traceScan,
      tokenEvents: tokenEventTypes,
      deployAttempts,
    },
  });
}

async function applySelfCorrection(mcp, failedDeploy) {
  const explain = failedDeploy.data?.explainFailure;
  if (!explain?.machineReadable) {
    throw new Error("expected NFR-017 machine-readable failure");
  }
  const verifyStep = explain.remediation.find((step) => step.machineAction === "verify");
  const deployStep = explain.remediation.find((step) => step.machineAction === "deploy");
  const verify = await mcp.callTool("verify", { camp: EPIC_REFERENCE.camp }, { toolCallId: "call-self-correct-verify" });
  const deploy = await mcp.callTool("deploy", {
    cwd: EPIC_REFERENCE.fixture,
    camp: EPIC_REFERENCE.camp,
  }, { toolCallId: "call-self-correct-deploy" });
  return deepFreeze({
    explain,
    verify,
    deploy,
    followedSteps: [verifyStep?.machineAction, deployStep?.machineAction].filter(Boolean),
  });
}

function replayJourney(events) {
  const digest = createHash("sha256").update(JSON.stringify(events)).digest("hex");
  const tokenTrail = events
    .filter((event) => isJsonString(event.type) && event.type.startsWith("token."))
    .map((event) => event.type);
  const deploySucceeded = events.some((event) => event.type === "deployment.Succeeded");
  return deepFreeze({
    digest,
    tokenTrail,
    deploySucceeded,
    replayable: tokenTrail.includes("token.Granted") && tokenTrail.includes("token.Used"),
  });
}

function buildNfr017Failure() {
  return deepFreeze({
    cause: "compat.GateFailed",
    rootCause: "bindle image digest pin missing for camp s2-sandbox",
    remediation: [
      {
        step: 1,
        action: "run hobo verify --camp s2-sandbox",
        machineAction: "verify",
      },
      {
        step: 2,
        action: "re-run deploy after verify passes",
        machineAction: "deploy",
      },
    ],
    machineReadable: true,
  });
}

function withListTemplatesTool(specs) {
  const listTemplates = Object.freeze({
    name: "list_templates",
    description: "J2 alias for template discovery (requirements.md J2 journey).",
    access: "read",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
    outputSchema: { type: "object", properties: { templates: { type: "array" } } },
    cliVerb: null,
    cliArgs: [],
    streaming: false,
    annotations: { readOnlyHint: true, destructiveHint: false },
  });
  return [...specs, listTemplates];
}

function journeyInput(tool) {
  switch (tool) {
    case "list_templates":
      return {};
    case "new":
      return { cwd: EPIC_REFERENCE.fixture, camp: EPIC_REFERENCE.camp };
    case "plan":
      return { cwd: EPIC_REFERENCE.fixture, camp: EPIC_REFERENCE.camp };
    case "deploy":
      return { cwd: EPIC_REFERENCE.fixture, camp: EPIC_REFERENCE.camp };
    case "inspect_run":
      return { runId: "run-hello-bindle-j2-1" };
    case "tail_logs":
      return { runId: "run-hello-bindle-j2-1" };
    default:
      return {};
  }
}

function fixtureRegistry() {
  return {
    async resolveAuthManifest(provider) {
      if (provider !== "s2-cloud") {
        return null;
      }
      return buildSignedAuthManifestEnvelope({
        issuer: "https://identity.s2.hobo.dev",
        scopeModel: "least-privilege-per-resource",
        resourceIndicators: ["urn:hobo:s2:compute"],
        tokenLifetimeSec: 300,
        audit: { events: ["token.Granted", "token.Used", "token.Denied"] },
        flows: [
          {
            type: "oidc-federation",
            audience: "urn:hobo:s2:compute",
            exchange: "https://sts.s2.hobo.dev/token",
            trust: { oidcDiscovery: "https://identity.s2.hobo.dev/.well-known/openid-configuration" },
          },
        ],
      }, {
        issuer: "https://identity.s2.hobo.dev",
        keyId: "s2-fixture-key",
      });
    },
  };
}

function createEventStore() {
  const events = [];
  return {
    append(event) {
      events.push(structuredClone(event));
      if (event.type === "token.Granted") {
        events.push({
          type: "deployment.Succeeded",
          time: event.time,
          data: { runId: "run-hello-bindle-j2-1", fixture: EPIC_REFERENCE.fixture },
        });
      }
    },
    snapshot() {
      return structuredClone(events);
    },
  };
}

function scanTraceForStaticSecrets(trace) {
  const serialized = JSON.stringify(trace);
  const findings = STATIC_SECRET_PATTERNS
    .filter((pattern) => pattern.test(serialized))
    .map((pattern) => pattern.source);
  return deepFreeze({
    staticSecretsFound: findings.length > 0,
    patterns: findings,
    brokeredOnly: findings.length === 0,
  });
}

function contractCovered(name, evidence) {
  switch (name) {
    case "j2-mcp-journey":
      return evidence.journey.length >= 4
        && evidence.selfCorrection?.deploy?.ok === true;
    case "brokered-token-audit":
      return evidence.tokenEventTypes.includes("token.Granted")
        && evidence.tokenEventTypes.includes("token.Used")
        && evidence.overBroadToken.ok === false;
    case "agent-guardrail-gate":
      return evidence.prodDeployBlocked.decision?.effect === "require-approval"
        && evidence.prodDeployApproved.ok === true;
    case "credential-audit-retention":
      return evidence.replay.replayable && evidence.traceScan.brokeredOnly;
    default:
      return false;
  }
}

function summarizeJourney(steps) {
  return steps.map((step) => ({
    tool: step.tool,
    ok: step.ok !== false,
    code: step.data?.code ?? step.error?.code,
  }));
}

function deepFreeze(value) {
  if (Array.isArray(value) || (value && isJsonObject(value))) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  return value;
}
