export const GATEKEEPER_VERIFY_SCHEMA = "hobo.gatekeeper-verify/v1";

export const REQUIRED_GATES = [
  "contracts",
  "policy",
  "eval",
  "conformance",
  "cost",
  "signing",
  "golden-suite",
  "deployment-plan",
];

const INCIDENT_REMEDIATION_EXEMPTIBLE_GATES = new Set(["burn-freeze"]);

export function evaluateGatekeeper({ target, request = {}, engines = {}, policy = {} } = {}) {
  if (!isNonEmptyString(target)) {
    throw new Error("target is required");
  }

  const results = [];
  for (const gate of REQUIRED_GATES) {
    const mandatoryFailure = mandatoryDisabledGateFailure({ target, request, policy, gate });
    results.push(mandatoryFailure ?? evaluateGate({ target, request, engines, gate }));
  }

  for (const gate of INCIDENT_REMEDIATION_EXEMPTIBLE_GATES) {
    if (isCallable(engines[gate])) {
      results.push(evaluateIncidentExemptibleGate({ target, request, engines, gate }));
    }
  }

  const failures = results
    .filter((result) => !result.ok)
    .map(failureView);
  const deployable = failures.length === 0;
  const suggestedFixes = unique(failures.flatMap((failure) => failure.suggestedFixes));
  const status = deployable ? "deployable" : "blocked";
  const events = [
    ...results.map((result) => gateEvent({ target, result })),
    decisionEvent({
      target,
      deployable,
      status,
      results,
      failures,
      suggestedFixes,
    }),
  ];

  return {
    schemaVersion: GATEKEEPER_VERIFY_SCHEMA,
    target,
    deployable,
    status,
    results,
    failures,
    suggestedFixes,
    events,
  };
}

export function replayGatekeeperDecision(events = []) {
  const event = events.at(-1);
  if (!event || !["gatekeeper.VerifyPassed", "gatekeeper.VerifyFailed"].includes(event.type)) {
    throw new Error("no gatekeeper verify event to replay");
  }

  return {
    schemaVersion: event.schemaVersion,
    target: event.target,
    deployable: event.deployable,
    status: event.status,
    results: event.results,
    failures: event.failures,
    suggestedFixes: event.suggestedFixes,
    events,
  };
}

export function runHoboVerifyCommand(args = [], fixtures = {}) {
  const target = parseTarget(args);
  if (!target) {
    throw new Error("missing required --target");
  }

  const decision = evaluateGatekeeper({
    target,
    request: fixtures.request ?? {},
    engines: fixtures.engines ?? {},
    policy: fixtures.policy ?? {},
  });

  return {
    command: "hobo verify",
    target,
    exitCode: decision.deployable ? 0 : 1,
    decision,
  };
}

function evaluateGate({ target, request, engines, gate }) {
  const engine = engines[gate];
  if (!isCallable(engine)) {
    return failClosedResult({
      gate,
      reason: "missing gate engine result",
      suggestedFixes: [`run ${gate} engine before hobo verify`],
      engineId: "gatekeeper/missing-engine",
    });
  }

  try {
    return normalizeEngineResult({
      gate,
      result: engine({ target, request, gate }),
    });
  } catch (error) {
    return failClosedResult({
      gate,
      reason: `gate engine error: ${error.message}`,
      suggestedFixes: [`rerun ${gate} engine and persist its result`],
      engineId: `engine/${gate}`,
    });
  }
}

function evaluateIncidentExemptibleGate(input) {
  const result = evaluateGate(input);
  if (!input.request.incidentRemediation || result.ok) {
    return result;
  }

  return {
    ...result,
    ok: true,
    exempted: true,
    originalOk: false,
    originalReason: result.reason,
    reason: `${result.reason} (incident remediation exemption)`,
  };
}

function mandatoryDisabledGateFailure({ target, request, policy, gate }) {
  const mandatory = policy.mandatoryGatesByTarget?.[target] ?? [];
  const disabled = request.disabledGates ?? [];
  if (!mandatory.includes(gate) || !disabled.includes(gate)) {
    return null;
  }

  return failClosedResult({
    gate,
    reason: `mandatory deny-ceiling forbids disabling ${gate} in ${target}`,
    suggestedFixes: [`remove disabledGates entry for ${gate}`],
    engineId: "gatekeeper/mandatory-gate",
  });
}

function normalizeEngineResult({ gate, result }) {
  if (!isObjectRecord(result)) {
    return failClosedResult({
      gate,
      reason: "gate engine returned no structured result",
      suggestedFixes: [`rerun ${gate} engine and persist its result`],
      engineId: `engine/${gate}`,
    });
  }

  if (result.gate !== gate) {
    return failClosedResult({
      gate,
      reason: `gate engine returned result for ${result.gate ?? "unknown"} instead of ${gate}`,
      suggestedFixes: [`discard mismatched ${gate} result and rerun ${gate} engine`],
      engineId: result.engineId ?? `engine/${gate}`,
    });
  }

  if (!isBoolean(result.ok)) {
    return failClosedResult({
      gate,
      reason: "gate engine result missing boolean ok",
      suggestedFixes: [`rerun ${gate} engine and persist its result`],
      engineId: result.engineId ?? `engine/${gate}`,
    });
  }

  if (result.suggestedFixes !== undefined && !Array.isArray(result.suggestedFixes)) {
    return failClosedResult({
      gate,
      reason: "gate engine suggestedFixes must be an array",
      suggestedFixes: [`fix ${gate} engine result shape`],
      engineId: result.engineId ?? `engine/${gate}`,
    });
  }

  const reason = result.reason ?? (result.ok ? `${gate} passed` : `${gate} failed`);
  const suggestedFixes = normalizeSuggestedFixes({
    gate,
    ok: result.ok,
    reason,
    suggestedFixes: result.suggestedFixes,
  });

  return {
    gate,
    ok: result.ok,
    reason,
    suggestedFixes,
    engineId: result.engineId ?? `engine/${gate}`,
  };
}

function failClosedResult({ gate, reason, suggestedFixes, engineId }) {
  return {
    gate,
    ok: false,
    reason,
    suggestedFixes,
    engineId,
  };
}

function failureView(result) {
  return {
    gate: result.gate,
    ok: false,
    reason: result.reason,
    suggestedFixes: result.suggestedFixes,
    engineId: result.engineId,
  };
}

function gateEvent({ target, result }) {
  const event = {
    type: result.ok ? "gatekeeper.GatePassed" : "gatekeeper.GateFailed",
    schemaVersion: GATEKEEPER_VERIFY_SCHEMA,
    target,
    gate: result.gate,
    ok: result.ok,
    reason: result.reason,
    suggestedFixes: result.suggestedFixes,
    engineId: result.engineId,
  };
  if (result.exempted) {
    event.exempted = true;
    event.originalReason = result.originalReason;
  }
  return event;
}

function decisionEvent({ target, deployable, status, results, failures, suggestedFixes }) {
  return {
    type: deployable ? "gatekeeper.VerifyPassed" : "gatekeeper.VerifyFailed",
    schemaVersion: GATEKEEPER_VERIFY_SCHEMA,
    target,
    deployable,
    status,
    results,
    failures,
    suggestedFixes,
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

function unique(values = []) {
  return [...new Set(values)].sort();
}

function normalizeSuggestedFixes({ gate, ok, reason, suggestedFixes = [] }) {
  const fixes = unique(suggestedFixes);
  if (ok || fixes.length > 0) {
    return fixes;
  }

  return [`resolve ${gate} failure: ${reason}`];
}

function isNonEmptyString(value) {
  return isString(value) && value.length > 0;
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isCallable(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isBoolean(value) {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
