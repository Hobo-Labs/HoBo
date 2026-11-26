import {
  createBuiltInPolicyEngine,
  evaluateAndRecordPolicyDecision,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import { evaluateCanDeploy } from "../../can-deploy-compatibility-gate-contract/src/compatibility-gate.js";
import { evaluateGatekeeper } from "../../gatekeeper-verify-contract/src/gatekeeper-verify.js";
import {
  replayObligationEvents,
  startObligationsFromDecision,
} from "../../obligation-engine-contract/src/obligation-engine.js";

import {
  createDeployPolicyRequest,
  DEPLOY_ACTION_ID,
  DEPLOY_TARGET,
  FIXED_DEPLOY_TIME,
} from "./fixtures.js";

export const GATEKEEPER_V1_SCHEMA = "hobo.gatekeeper-v1/v1";

const STUB_GATES = ["eval", "conformance", "cost", "signing", "golden-suite", "deployment-plan"];

export async function verifyDeployAtPoint({
  target = DEPLOY_TARGET,
  deploymentId,
  fixtures = {},
  at = FIXED_DEPLOY_TIME,
} = {}) {
  const compatibility = evaluateCanDeploy({
    target,
    camp: fixtures.camp ?? { enforcementMode: "strict" },
    proposedSet: fixtures.proposedSet ,
    eventLog: fixtures.eventLog ?? [],
  });

  const policyRequest = createDeployPolicyRequest({
    resource: { kind: "deployment", id: deploymentId ?? fixtures.deploymentId ?? `deployment:${target}` },
    context: {
      yard: "yard-prod",
      camp: target,
      provider: fixtures.provider ?? "mocked-reference",
      exposesPublicEndpoint: fixtures.exposesPublicEndpoint ?? false,
      contractResults: { compatible: compatibility.ok },
    },
  });

  const policyAuditEvents = [];
  const policyDecision = fixtures.policyRuleset
    ? await evaluateAndRecordPolicyDecision({
        engine: createBuiltInPolicyEngine(),
        request: policyRequest,
        ruleset: fixtures.policyRuleset,
        auditSink: (event) => policyAuditEvents.push(event),
      })
    : allowPolicyDecision(policyRequest);

  const obligationCreated = startObligationsFromDecision({
    request: policyRequest,
    decision: policyDecision,
    at,
  });
  const obligationReplay = replayObligationEvents(obligationCreated.events);

  const gatekeeper = evaluateGatekeeper({
    target,
    request: {
      deploymentId: deploymentId ?? fixtures.deploymentId,
      action: DEPLOY_ACTION_ID,
      policyRequest,
    },
    engines: createDeployGateEngines({ compatibility, policyDecision, obligationReplay }),
  });

  const events = [
    ...compatibility.events,
    ...policyAuditEvents,
    ...obligationCreated.events,
    ...gatekeeper.events,
    deployVerificationEvent({
      target,
      deploymentId: deploymentId ?? fixtures.deploymentId,
      at,
      deployable: gatekeeper.deployable,
      compatibility,
      policyDecision,
      obligationReplay,
      gatekeeper,
    }),
  ];

  return {
    schemaVersion: GATEKEEPER_V1_SCHEMA,
    target,
    deploymentId: deploymentId ?? fixtures.deploymentId,
    deployable: gatekeeper.deployable,
    status: gatekeeper.status,
    compatibility,
    policyDecision,
    obligations: obligationReplay.obligations,
    gatekeeper,
    events,
  };
}

export function replayDeployVerification(events = []) {
  const event = events.find((entry) => entry.type === "gatekeeper.DeployVerified");
  if (!event) {
    throw new Error("no gatekeeper.DeployVerified event to replay");
  }

  return {
    schemaVersion: event.schemaVersion,
    target: event.target,
    deploymentId: event.deploymentId,
    deployable: event.deployable,
    status: event.status,
    compatibility: event.compatibility,
    policyDecision: event.policyDecision,
    obligations: event.obligations,
    gatekeeper: event.gatekeeper,
    events,
  };
}

export async function runHoboVerifyDeploy(args = [], fixtures = {}) {
  const target = parseTarget(args) ?? fixtures.target ?? DEPLOY_TARGET;
  const result = await verifyDeployAtPoint({ target, fixtures });
  return {
    command: "hobo verify",
    target,
    exitCode: result.deployable ? 0 : 1,
    result,
  };
}

function createDeployGateEngines({ compatibility, policyDecision, obligationReplay: _obligationReplay }) {
  const engines = Object.fromEntries(
    STUB_GATES.map((gate) => [
      gate,
      () => ({
        gate,
        ok: true,
        reason: `${gate} passed (stub)`,
        suggestedFixes: [],
        engineId: `engine/${gate}`,
      }),
    ]),
  );

  engines.contracts = () => ({
    gate: "contracts",
    ok: compatibility.ok,
    reason: compatibility.ok
      ? "contracts compatible"
      : compatibility.summary ?? "contract compatibility failed",
    suggestedFixes: compatibility.suggestedFixes ?? [],
    engineId: "engine/contracts",
  });

  engines.policy = () => ({
    gate: "policy",
    ok: policyDecision.effect !== "deny",
    reason: policyDecision.reason,
    suggestedFixes:
      policyDecision.effect === "deny"
        ? policyDecision.violations.map((violation) => `resolve policy violation: ${violation}`)
        : [],
    engineId: "engine/policy",
  });

  return engines;
}

function allowPolicyDecision(request) {
  return {
    schemaVersion: "hobo.policy-ir/v1",
    effect: "allow",
    reason: "no policy rules matched",
    violations: [],
    mutations: [],
    approvals: [],
    obligations: [],
    evidence: {
      policyIds: [],
      inputHash: request.inputHash,
      engine: "hobo.policy-engine/built-in-typescript@0.1.0",
    },
  };
}

function deployVerificationEvent({
  target,
  deploymentId,
  at,
  deployable,
  compatibility,
  policyDecision,
  obligationReplay,
  gatekeeper,
}) {
  return {
    type: "gatekeeper.DeployVerified",
    schemaVersion: GATEKEEPER_V1_SCHEMA,
    target,
    deploymentId,
    at,
    deployable,
    status: gatekeeper.status,
    compatibility: {
      ok: compatibility.ok,
      summary: compatibility.summary,
      eventType: compatibility.events.at(-1)?.type,
    },
    policyDecision: {
      effect: policyDecision.effect,
      reason: policyDecision.reason,
      eventType: "policy.Decided",
    },
    obligations: obligationReplay.obligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      status: obligation.status,
    })),
    gatekeeper: {
      failures: gatekeeper.failures,
      suggestedFixes: gatekeeper.suggestedFixes,
    },
  };
}

function parseTarget(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      return args[index + 1];
    }
    if (arg.startsWith("--target=")) {
      return arg.slice("--target=".length);
    }
  }
  return undefined;
}
