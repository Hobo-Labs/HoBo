import { isJsonObject } from "../src/json.js";
import { evaluateCanDeploy } from "../../../technical-proofs/can-deploy-compatibility-gate-contract/src/compatibility-gate.js";
import {
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  createRuleset,
  defineTypescriptRule,
  evaluateAndRecordPolicyDecision,
} from "../../../technical-proofs/built-in-policy-engine-contract/src/built-in-policy-engine.js";
import {
  allowRule,
  composePolicyPacks,
  definePolicyPack,
  denyRule,
} from "../../../technical-proofs/deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import { evaluateGatekeeper } from "../../../technical-proofs/gatekeeper-verify-contract/src/gatekeeper-verify.js";
import {
  CONTRACT_MODES,
  createContractFixture,
} from "../../../technical-proofs/hobo-contract-ir/src/contract-ir.js";
import {
  createReferenceObligation,
  evaluateObligationGate,
  recordObligationEffectCompleted,
  satisfyObligation,
  startObligationsFromDecision,
} from "../../../technical-proofs/obligation-engine-contract/src/obligation-engine.js";
import { evaluatePolicyWithFailClosedFallback } from "../../../technical-proofs/policy-fail-closed-contract/src/policy-fail-closed.js";
import {
  authorizeControlPlaneAction,
  bindPrincipalToRole,
  resolveRbacSubject,
} from "../../../technical-proofs/rbac-role-binding-contract/src/rbac-role-binding.js";
import {
  createGovernanceConformanceFixture,
  evaluateGovernanceConformance,
  replayGovernanceDecisionLog,
} from "../../../technical-proofs/governance-conformance-suite-contract/src/governance-conformance-suite.js";

export const REFERENCE_IMPLEMENTATION_ID = "hobo.epic-reference/contracts-policy-governance@0.1.0";
export const FIXED_SIMULATION_TIME = "2026-06-29T02:12:58.000Z";
export const DEPLOY_TARGET = "prod";
export const DEPLOY_ACTION_ID = "hobo:delta:promote";
export const DEPLOY_TUPLE = "deployment:hobo:delta:promote:apply";

export const BOUNDARY_CONTRACTS = Object.freeze([
  boundary("Gatekeeper to Contract Engine", "Gatekeeper Verify", "Contract Engine", "gatekeeper-contract-engine.json", "consumer_tested"),
  boundary("Gatekeeper to Policy Engine", "Gatekeeper Verify", "Built-in Policy Engine", "gatekeeper-policy-engine.json", "consumer_tested"),
  boundary("Gatekeeper to Obligation Engine", "Gatekeeper Verify", "Obligation Engine", "gatekeeper-obligation-engine.json", "consumer_tested"),
  boundary("Gatekeeper to Cost/Quota Policy", "Gatekeeper Verify", "Cost/Quota Policy", "gatekeeper-cost-quota.json", "mocked_provider_unavailable"),
  boundary("Gatekeeper to Artifact Provenance Verifier", "Gatekeeper Verify", "Artifact Provenance Verifier", "gatekeeper-artifact-provenance.json", "mocked_provider_unavailable"),
  boundary("Policy Engine to Policy Pack Registry", "Built-in Policy Engine", "Policy Pack Registry", "policy-engine-policy-pack-registry.json", "consumer_tested"),
  boundary("Policy Engine to RBAC Directory", "Built-in Policy Engine", "RBAC Directory", "policy-engine-rbac-directory.json", "consumer_tested"),
  boundary("Policy Engine to Audit Log", "Built-in Policy Engine", "Audit Log", "policy-engine-audit-log.json", "mocked_provider_unavailable"),
  boundary("Contract Engine to Deployed State Projection", "Contract Engine", "Deployed State Projection", "contract-engine-deployed-state.json", "mocked_provider_unavailable"),
  boundary("Governance Suite to Evidence Store", "Governance Conformance Suite", "Audit Log/Event Projection", "governance-suite-evidence-store.json", "mocked_provider_unavailable"),
]);

export function createMockBoundaryHarness(overrides = {}) {
  const fixtures = mergeFixtures(defaultFixtures(), overrides.fixtures ?? {});
  const boundaryDecisions = {};

  return {
    fixtures,
    policyProviderMode: overrides.policyProviderMode ?? "available",
    networkCalls: [],
    boundaryCalls: [],
    evidenceLog: [],
    recordBoundary(boundaryName, decision = {}) {
      const contract = BOUNDARY_CONTRACTS.find((entry) => entry.boundary === boundaryName);
      if (!contract) {
        throw new Error(`unknown boundary: ${boundaryName}`);
      }
      const normalized = {
        boundary: boundaryName,
        consumer: contract.consumer,
        provider: contract.provider,
        status: decision.status ?? contract.status,
        ok: decision.ok ?? true,
        evidence: decision.evidence ?? {},
      };
      boundaryDecisions[boundaryName] = normalized;
      this.boundaryCalls.push(normalized);
      return normalized;
    },
    boundaryDecisions() {
      return Object.fromEntries(
        BOUNDARY_CONTRACTS.map((contract) => [
          contract.boundary,
          boundaryDecisions[contract.boundary] ?? {
            boundary: contract.boundary,
            consumer: contract.consumer,
            provider: contract.provider,
            status: "planned",
            ok: false,
            evidence: {},
          },
        ]),
      );
    },
  };
}

export async function runGovernedDeploySimulation(harness = createMockBoundaryHarness()) {
  const compatibilityDecision = evaluateCanDeploy({
    target: harness.fixtures.target,
    camp: harness.fixtures.camp,
    proposedSet: harness.fixtures.proposedSet,
    eventLog: harness.fixtures.eventLog,
  });
  harness.recordBoundary("Contract Engine to Deployed State Projection", {
    status: "mocked_provider_unavailable",
    evidence: { eventCount: harness.fixtures.eventLog.length },
  });
  harness.recordBoundary("Gatekeeper to Contract Engine", {
    status: "consumer_tested",
    ok: compatibilityDecision.ok,
    evidence: { summary: compatibilityDecision.summary, matrixRows: compatibilityDecision.matrix.length },
  });

  const rbacSubject = resolveRbacSubject({
    principal: harness.fixtures.principal,
    auth: harness.fixtures.auth,
    bindings: harness.fixtures.bindings,
  });
  const authorization = authorizeControlPlaneAction({
    subject: rbacSubject,
    actionId: DEPLOY_ACTION_ID,
  });
  harness.recordBoundary("Policy Engine to RBAC Directory", {
    status: "consumer_tested",
    ok: authorization.effect === "allow",
    evidence: { roles: rbacSubject.roles, authorization },
  });

  const policyRequest = createPolicyRequest(rbacSubject);
  const ruleset = createGovernedDeployRuleset();
  const policyAuditEvents = [];
  const policyDecision = await evaluateAndRecordPolicyDecision({
    engine: createBuiltInPolicyEngine(),
    request: policyRequest,
    ruleset,
    auditSink: (event) => {
      policyAuditEvents.push(event);
      harness.evidenceLog.push(event);
    },
  });
  harness.recordBoundary("Policy Engine to Policy Pack Registry", {
    status: "consumer_tested",
    evidence: { packIds: ruleset.policyPacks.map((pack) => pack.id) },
  });
  harness.recordBoundary("Policy Engine to Audit Log", {
    status: "mocked_provider_unavailable",
    evidence: { eventCount: policyAuditEvents.length },
  });
  harness.recordBoundary("Gatekeeper to Policy Engine", {
    status: "consumer_tested",
    ok: policyDecision.effect !== "deny",
    evidence: { effect: policyDecision.effect, policyIds: policyDecision.evidence.policyIds },
  });

  const obligationEvents = satisfyDecisionObligations(policyRequest, policyDecision);
  const obligationGate = evaluateObligationGate(obligationEvents);
  harness.recordBoundary("Gatekeeper to Obligation Engine", {
    status: "consumer_tested",
    ok: !obligationGate.blocked,
    evidence: { satisfied: obligationGate.satisfied.map((entry) => entry.id) },
  });

  const costDecision = harness.fixtures.costQuota;
  harness.recordBoundary("Gatekeeper to Cost/Quota Policy", {
    status: "mocked_provider_unavailable",
    ok: costDecision.ok,
    evidence: costDecision,
  });
  const provenanceDecision = harness.fixtures.artifactProvenance;
  harness.recordBoundary("Gatekeeper to Artifact Provenance Verifier", {
    status: "mocked_provider_unavailable",
    ok: provenanceDecision.ok,
    evidence: provenanceDecision,
  });

  const conformance = evaluateGovernanceConformance(createGovernanceFixture({
    contracts: compatibilityDecision.ok,
    policy: policyDecision.effect !== "deny",
    obligations: !obligationGate.blocked,
    quota: costDecision.ok,
    signing: provenanceDecision.ok,
  }));
  const conformanceReplay = replayGovernanceDecisionLog(conformance.events);
  harness.recordBoundary("Governance Suite to Evidence Store", {
    status: "mocked_provider_unavailable",
    ok: conformance.deployable,
    evidence: { replayMatches: conformanceReplay.matchesRecordedDecision },
  });

  const gatekeeper = evaluateGatekeeper({
    target: harness.fixtures.target,
    request: { deployId: harness.fixtures.deploymentId, artifact: harness.fixtures.artifact },
    engines: createGateEngines({
      compatibilityDecision,
      policyDecision,
      obligationGate,
      costDecision,
      provenanceDecision,
      conformance,
    }),
    policy: mandatoryGatePolicy(),
  });

  const boundaryDecisions = harness.boundaryDecisions();
  return {
    scenario: "compatible deploy produces auditable approval obligations",
    referenceImplementationId: REFERENCE_IMPLEMENTATION_ID,
    contractModes: [...CONTRACT_MODES],
    contractFixture: createContractFixture({ mode: "promoted" }),
    rbacSubject,
    authorization,
    compatibilityDecision,
    policyDecision,
    obligationGate,
    conformance,
    conformanceReplay,
    gatekeeper,
    boundaryDecisions,
    coverage: validateBoundaryCoverage(boundaryDecisions),
  };
}

export async function runDenyCeilingBypassSimulation(harness = createMockBoundaryHarness()) {
  const denyCeiling = composePolicyPacks([
    definePolicyPack({
      id: "yard-prod-mandatory-governance",
      scope: "yard",
      rules: [denyRule({ id: "mandatory-prod-deploy-deny", tuple: DEPLOY_TUPLE })],
    }),
    definePolicyPack({
      id: "bindle-bypass-attempt",
      scope: "bindle",
      rules: [allowRule({ id: "allow-prod-deploy-anyway", tuple: DEPLOY_TUPLE })],
    }),
  ]);
  harness.recordBoundary("Gatekeeper to Policy Engine", {
    status: "consumer_tested",
    ok: false,
    evidence: { denyCeiling },
  });

  const gatekeeper = evaluateGatekeeper({
    target: harness.fixtures.target,
    request: { disabledGates: ["contracts", "golden-suite"] },
    engines: createAllPassingGateEngines("bypass negative fixture"),
    policy: mandatoryGatePolicy(),
  });

  return {
    scenario: "mandatory governance cannot be bypassed",
    denyCeiling,
    gatekeeper,
    boundaryDecisions: harness.boundaryDecisions(),
  };
}

export async function runFailClosedSimulation(harness = createMockBoundaryHarness({ policyProviderMode: "unavailable" })) {
  const failClosedDecision = evaluatePolicyWithFailClosedFallback({
    request: createPolicyRequest(resolveRbacSubject({
      principal: harness.fixtures.principal,
      auth: harness.fixtures.auth,
      bindings: harness.fixtures.bindings,
    })),
    ruleset: createGovernedDeployRuleset(),
    evaluator: () => {
      throw new Error("policy pack registry unavailable");
    },
  });
  harness.recordBoundary("Gatekeeper to Policy Engine", {
    status: harness.policyProviderMode === "unavailable" ? "mocked_provider_unavailable" : "consumer_tested",
    ok: false,
    evidence: { reason: failClosedDecision.reason },
  });

  const gatekeeper = evaluateGatekeeper({
    target: harness.fixtures.target,
    request: { deployId: harness.fixtures.deploymentId },
    engines: {
      ...createAllPassingGateEngines("fail-closed fixture"),
      policy: () => gateResult({
        gate: "policy",
        ok: false,
        reason: failClosedDecision.reason,
        engineId: "hobo.policy-fail-closed/fallback@0.1.0",
        suggestedFixes: ["restore signed policy-pack registry before deploy"],
      }),
    },
    policy: mandatoryGatePolicy(),
  });

  return {
    scenario: "policy uncertainty fails closed",
    failClosedDecision,
    gatekeeper,
    boundaryDecisions: harness.boundaryDecisions(),
  };
}

export function validateBoundaryCoverage(boundaryDecisions) {
  const expected = BOUNDARY_CONTRACTS.map((entry) => entry.boundary).sort();
  const actual = Object.keys(boundaryDecisions ?? {}).sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((boundaryName) => !actualSet.has(boundaryName));
  const extra = actual.filter((boundaryName) => !expectedSet.has(boundaryName));

  return {
    ok: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}

function boundary(boundaryName, consumer, provider, pactFile, status) {
  return Object.freeze({
    boundary: boundaryName,
    consumer,
    provider,
    protocol: "in-process request/response",
    pactFile: `contracts/pacts/${pactFile}`,
    status,
  });
}

function defaultFixtures() {
  return {
    target: DEPLOY_TARGET,
    deploymentId: "deployment:checkout-prod",
    artifact: {
      id: "bindle:checkout-api@2.4.0",
      digest: "sha256:checkout-prod-reference",
    },
    principal: {
      kind: "agent",
      id: "spiffe://tenant-a/yard/prod/agent/deployer",
    },
    auth: {
      port: "hobo:auth",
      scimGroups: [],
      adapter: "mock-hobo-auth",
    },
    bindings: [
      bindPrincipalToRole({
        principalId: "spiffe://tenant-a/yard/prod/agent/deployer",
        roleId: "deployer",
      }),
    ],
    camp: {
      enforcementMode: "strict",
    },
    eventLog: [
      {
        type: "deployment.Running",
        target: DEPLOY_TARGET,
        component: "checkout-worker",
        version: "1.7.0",
        consumes: [
          {
            producer: "checkout-api",
            channel: "orders.http",
            contractVersion: "1.2.0",
            requiredFields: ["id", "tenantId", "total"],
          },
        ],
        produces: [],
      },
    ],
    proposedSet: {
      producers: [
        {
          component: "checkout-api",
          version: "2.4.0",
          channel: "orders.http",
          contractVersion: "1.3.0",
          provides: ["id", "tenantId", "total", "currency"],
        },
      ],
      consumers: [],
    },
    costQuota: {
      ok: true,
      quota: "deployments/day",
      remaining: 7,
      limit: 20,
    },
    artifactProvenance: {
      ok: true,
      signer: "hobo-release-bot",
      digest: "sha256:checkout-prod-reference",
      trustPolicy: "mocked-attestation",
    },
  };
}

function mergeFixtures(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? structuredClone(base) : structuredClone(overrides);
  }
  if (!base || !isJsonObject(base)) {
    return overrides === undefined ? base : overrides;
  }
  const output = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    output[key] = mergeFixtures(output[key], value);
  }
  return output;
}

function createPolicyRequest(subject) {
  return createGoldenDecisionRequest({
    subject: {
      kind: subject.kind,
      id: subject.id,
      roles: subject.roles,
      scopes: ["hobo:delta:promote"],
      delegatedBy: "user:platform-admin",
    },
    action: DEPLOY_ACTION_ID,
    resource: {
      kind: "deployment",
      id: "deployment:checkout-prod",
    },
    phase: "apply",
    context: {
      yard: "yard-prod",
      camp: DEPLOY_TARGET,
      provider: "mocked-reference",
    },
  });
}

function createGovernedDeployRuleset() {
  return createRuleset({
    id: "policy-pack:contracts-policy-governance-reference",
    version: "1.0.0",
    policyPacks: [
      definePolicyPack({
        id: "yard-prod-governance",
        scope: "yard",
        rules: [
          {
            id: "limit-daily-prod-deploys",
            mode: "mandatory",
            denies: [],
            allows: [],
            limits: [{ key: "deployments/day", maximum: 20 }],
          },
        ],
      }),
    ],
    rules: [
      defineTypescriptRule({
        id: "prod-deploy-requires-approval-and-canary",
        when: ({ request }) => request.action === DEPLOY_ACTION_ID,
        decide: () => ({
          effect: "require-approval",
          reason: "production deploy requires approval and canary obligations",
          approvals: ["security-governance-lead"],
          obligations: [
            createReferenceObligation("require-approval", {
              id: "obl:approval:checkout-prod",
              effectId: "effect:approval:checkout-prod",
              deadline: "2026-06-29T04:12:58.000Z",
              metadata: { approverRole: "security-policy-admin" },
            }),
            createReferenceObligation("require-canary", {
              id: "obl:canary:checkout-prod",
              effectId: "effect:canary:checkout-prod",
              deadline: "2026-06-29T06:12:58.000Z",
              metadata: { canaryPercent: 10 },
            }),
          ],
        }),
      }),
    ],
  });
}

function satisfyDecisionObligations(request, decision) {
  const idFactory = deterministicIdFactory();
  const created = startObligationsFromDecision({
    request,
    decision,
    at: FIXED_SIMULATION_TIME,
    idFactory,
  });
  const lifecycle = [...created.events];

  for (const event of created.events) {
    const obligation = event.data.obligation;
    const completed = recordObligationEffectCompleted({
      obligationId: obligation.id,
      effectId: obligation.effect.id,
      result: { source: "mocked-reference-simulation", ok: true },
      at: "2026-06-29T02:13:58.000Z",
      idFactory,
    });
    const satisfied = satisfyObligation({
      obligationId: obligation.id,
      effectId: obligation.effect.id,
      at: "2026-06-29T02:14:58.000Z",
      idFactory,
    });
    lifecycle.push(completed, satisfied);
  }

  return lifecycle;
}

function createGateEngines({
  compatibilityDecision,
  policyDecision,
  obligationGate,
  costDecision,
  provenanceDecision,
  conformance,
}) {
  return {
    contracts: () => gateResult({
      gate: "contracts",
      ok: compatibilityDecision.ok,
      reason: compatibilityDecision.summary,
      engineId: "hobo.contract-engine/can-deploy@0.1.0",
      suggestedFixes: compatibilityDecision.suggestedFixes,
    }),
    policy: () => gateResult({
      gate: "policy",
      ok: policyDecision.effect !== "deny",
      reason: policyDecision.reason,
      engineId: policyDecision.evidence.engine,
      suggestedFixes: policyDecision.violations ?? [],
    }),
    eval: () => passGate("eval", "reference evaluation fixture passed"),
    conformance: () => gateResult({
      gate: "conformance",
      ok: conformance.deployable,
      reason: conformance.decision.reason,
      engineId: conformance.suiteId,
      suggestedFixes: conformance.blockedBy.map((entry) => entry.reason),
    }),
    cost: () => gateResult({
      gate: "cost",
      ok: costDecision.ok,
      reason: costDecision.ok ? "quota available" : "quota unavailable",
      engineId: "hobo.cost-quota/mock@0.1.0",
    }),
    signing: () => gateResult({
      gate: "signing",
      ok: provenanceDecision.ok,
      reason: provenanceDecision.ok ? "artifact provenance verified" : "artifact provenance rejected",
      engineId: "hobo.artifact-provenance/mock@0.1.0",
    }),
    "golden-suite": () => passGate("golden-suite", "governance golden replay passed"),
    "deployment-plan": () => passGate("deployment-plan", "deployment plan constraints satisfied"),
    obligations: () => gateResult({
      gate: "obligations",
      ok: !obligationGate.blocked,
      reason: obligationGate.blocked ? "obligations pending" : "obligations satisfied",
      engineId: "hobo.obligation-engine/contract@0.1.0",
      suggestedFixes: obligationGate.reasons.map((entry) => entry.reason),
    }),
  };
}

function createAllPassingGateEngines(reason) {
  return {
    contracts: () => passGate("contracts", reason),
    policy: () => passGate("policy", reason),
    eval: () => passGate("eval", reason),
    conformance: () => passGate("conformance", reason),
    cost: () => passGate("cost", reason),
    signing: () => passGate("signing", reason),
    "golden-suite": () => passGate("golden-suite", reason),
    "deployment-plan": () => passGate("deployment-plan", reason),
  };
}

function createGovernanceFixture({ contracts, policy, obligations, quota, signing }) {
  const status = (ok) => ok ? "pass" : "fail";
  return createGovernanceConformanceFixture({
    id: "governance-conformance:contracts-policy-governance",
    recordedAt: FIXED_SIMULATION_TIME,
    target: {
      command: "hobo verify",
      environment: DEPLOY_TARGET,
      deploymentId: "deployment:checkout-prod",
    },
    policyPackVersion: "contracts-policy-governance-reference@1.0.0",
    gateResults: [
      gateDimension("contracts", status(contracts)),
      gateDimension("policy", status(policy)),
      gateDimension("obligations", status(obligations)),
      gateDimension("residency", "pass"),
      gateDimension("guardrail-coverage", "pass"),
      gateDimension("quota", status(quota)),
      gateDimension("signing", status(signing)),
    ],
  });
}

function gateDimension(dimension, status) {
  return {
    dimension,
    status,
    reason: status === "pass" ? `${dimension} reference evidence passed` : `${dimension} reference evidence failed`,
    evidence: {
      producer: `mock-${dimension}`,
      digest: `sha256:${dimension}-contracts-policy-governance`,
    },
  };
}

function mandatoryGatePolicy() {
  return {
    mandatoryGatesByTarget: {
      [DEPLOY_TARGET]: [
        "contracts",
        "policy",
        "eval",
        "conformance",
        "cost",
        "signing",
        "golden-suite",
        "deployment-plan",
      ],
    },
  };
}

function gateResult({ gate, ok, reason, engineId, suggestedFixes = [] }) {
  return {
    gate,
    ok,
    reason,
    engineId,
    suggestedFixes,
  };
}

function passGate(gate, reason) {
  return gateResult({
    gate,
    ok: true,
    reason,
    engineId: `mock/${gate}`,
  });
}

function deterministicIdFactory() {
  let sequence = 0;
  return (prefix) => `${prefix}-${String(sequence += 1).padStart(3, "0")}`;
}
