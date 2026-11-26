import { createHash } from "node:crypto";

import {
  POLICY_IR_SCHEMA_VERSION,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";

export const MCP_HARDENING_CONTRACT_VERSION = "hobo.mcp-hardening/v1";
export const MCP_HARDENING_ENGINE_ID = "hobo.mcp-hardening@0.1.0";

export const DEFAULT_MCP_TOOL_CONTRACTS = Object.freeze({
  plan: Object.freeze({
    phase: "plan",
    resource: { kind: "mcp-tool", id: "plan" },
    requiredScope: "tool:plan",
    costCents: 3,
    policyIds: ["mcp/tool-scope", "mcp/read-default"],
  }),
  tail_logs: Object.freeze({
    phase: "observe",
    resource: { kind: "mcp-tool", id: "tail_logs" },
    requiredScope: "tool:tail_logs",
    costCents: 1,
    policyIds: ["mcp/tool-scope", "mcp/tool-results-untrusted"],
  }),
  request_token: Object.freeze({
    phase: "runtime",
    resource: { kind: "mcp-tool", id: "request_token" },
    requiredScope: "tool:request_token",
    costCents: 0,
    policyIds: ["mcp/tool-scope", "mcp/token-scope"],
  }),
  deploy: Object.freeze({
    phase: "apply",
    resource: { kind: "mcp-tool", id: "deploy" },
    requiredScope: "tool:deploy",
    costCents: 5,
    approvalWhen: isProdTarget,
    approvalRole: "Deployer",
    policyIds: ["mcp/tool-scope", "mcp/high-risk-approval"],
  }),
  destroy: Object.freeze({
    phase: "apply",
    resource: { kind: "mcp-tool", id: "destroy" },
    requiredScope: "tool:destroy",
    costCents: 10,
    approvalWhen: () => true,
    approvalRole: "Security-Admin",
    policyIds: ["mcp/tool-scope", "mcp/destructive-approval"],
  }),
  down: Object.freeze({
    phase: "apply",
    resource: { kind: "mcp-tool", id: "down" },
    requiredScope: "tool:down",
    costCents: 10,
    approvalWhen: () => true,
    approvalRole: "Security-Admin",
    policyIds: ["mcp/tool-scope", "mcp/destructive-approval"],
  }),
});

export function createAgentPrincipal(input = {}) {
  const delegatedBy = input.delegatedBy ?? { kind: "user", id: "user:unknown" };
  return deepFreeze({
    kind: "agent",
    id: requireString(input.id, "id"),
    delegatedBy: normalizePrincipalRef(delegatedBy, "delegatedBy"),
    grantId: requireString(input.grantId, "grantId"),
    roles: normalizeStringArray(input.roles ?? [], "roles"),
    scopes: normalizeStringArray(input.scopes ?? [], "scopes"),
    spendCapCents: normalizeNonNegativeNumber(input.spendCapCents ?? 0, "spendCapCents"),
  });
}

export function createMcpSecurityGateway(options = {}) {
  const toolContracts = Object.assign({}, DEFAULT_MCP_TOOL_CONTRACTS, options.toolContracts);
  const auditEvents = [];
  const spendByRunAndSubject = new Map();
  const approvalHooks = new Map();
  const revokedGrants = new Set();
  let hookSequence = 0;
  let tokenSequence = 0;

  function invokeTool(input = {}) {
    const runId = requireString(input.runId, "runId");
    const subject = normalizeAgentSubject(input.subject);
    const toolName = requireString(input.toolName, "toolName");
    const tool = toolContracts[toolName];

    if (revokedGrants.has(revocationKey(subject))) {
      const decision = recordDecision({
        runId,
        subject,
        toolName,
        tool,
        effect: "deny",
        reason: "grant revoked mid-plan",
        context: { revocation: { grantId: subject.grantId } },
        policyIds: ["mcp/grant-revocation"],
      });
      return denyResult(decision);
    }

    if (!tool) {
      const decision = recordDecision({
        runId,
        subject,
        toolName,
        effect: "deny",
        reason: `unknown MCP tool ${toolName}`,
        context: { input: cloneJson(input.input ?? {}) },
        policyIds: ["mcp/deny-by-default"],
      });
      return denyResult(decision);
    }

    if (!subject.scopes.includes(tool.requiredScope)) {
      const decision = recordDecision({
        runId,
        subject,
        toolName,
        tool,
        effect: "deny",
        reason: `tool ${toolName} is not granted to ${subject.id}`,
        context: { requiredScope: tool.requiredScope, subjectScopes: subject.scopes },
        policyIds: ["mcp/tool-scope"],
      });
      return denyResult(decision);
    }

    if (toolName === "request_token") {
      return requestToken({ runId, subject, input: input.input ?? {}, tool });
    }

    if (tool.approvalWhen instanceof Function && tool.approvalWhen(input.input ?? {})) {
      const hook = createApprovalHook({ runId, subject, toolName, tool, input: input.input ?? {} });
      const decision = recordDecision({
        runId,
        subject,
        toolName,
        tool,
        effect: "require-approval",
        reason: `MCP tool ${toolName} requires human approval`,
        approvals: [
          {
            hookId: hook.id,
            requiredRole: hook.requiredRole,
            requester: hook.requester,
            status: "pending",
          },
        ],
        obligations: [
          {
            kind: "human-approval",
            hookId: hook.id,
            approverRole: hook.requiredRole,
            requester: hook.requester,
          },
        ],
        context: { input: cloneJson(input.input ?? {}), hookId: hook.id },
        policyIds: tool.policyIds,
      });
      return {
        ok: false,
        executed: false,
        decision,
        hook,
      };
    }

    const spendCheck = reserveSpend({ runId, subject, tool, spendByRunAndSubject });
    if (!spendCheck.ok) {
      const decision = recordDecision({
        runId,
        subject,
        toolName,
        tool,
        effect: "deny",
        reason: spendCheck.reason,
        context: spendCheck.context,
        policyIds: ["mcp/spend-cap"],
      });
      return { ...denyResult(decision), throttled: true };
    }

    const decision = recordDecision({
      runId,
      subject,
      toolName,
      tool,
      effect: "allow",
      reason: `MCP tool ${toolName} allowed within delegated scope`,
      context: { input: cloneJson(input.input ?? {}) },
      policyIds: tool.policyIds,
    });

    return {
      ok: true,
      executed: true,
      decision,
      output: executeFixtureTool({ toolName, input: input.input ?? {} }),
    };
  }

  function requestToken({ runId, subject, input, tool }) {
    const provider = requireString(input.provider, "input.provider");
    const scope = normalizeTokenScope(input.scope);
    const scopeKey = tokenScopeKey(provider, scope);

    if (!isExactTokenScopeAllowed(subject, scopeKey)) {
      const decision = recordDecision({
        runId,
        subject,
        toolName: "request_token",
        tool,
        effect: "deny",
        reason: `requested token scope ${scopeKey} is outside delegated token scope`,
        context: { requestedScope: scopeKey, subjectScopes: subject.scopes },
        policyIds: ["mcp/token-scope"],
      });
      const tokenEvent = createValidatedIdentityEvent("token.Denied", {
        requestId: `${runId}:request-token:${scopeKey}`,
        subject: principalForIdentityEvent(subject),
        target: { kind: "provider", id: provider },
        reason: decision.reason,
      }, {
        correlationId: runId,
        causationId: decision.evidence.inputHash,
      });
      auditEvents.push(tokenEvent);
      return { ...denyResult(decision), tokenEvent };
    }

    const decision = recordDecision({
      runId,
      subject,
      toolName: "request_token",
      tool,
      effect: "allow",
      reason: `request_token allowed for ${scopeKey}`,
      context: { requestedScope: scopeKey },
      policyIds: ["mcp/token-scope"],
    });
    const grantId = `grant-token-${++tokenSequence}`;
    const tokenEvent = createValidatedIdentityEvent("token.Granted", {
      grantId,
      subject: principalForIdentityEvent(subject),
      target: { kind: "provider", id: provider },
      audience: provider,
      scopes: [scopeKey],
      tokenRef: `token-ref://${grantId}`,
      expiresAt: "2026-06-28T00:00:00.000Z",
    }, {
      correlationId: runId,
      causationId: decision.evidence.inputHash,
    });
    const usedEvent = createValidatedIdentityEvent("token.Used", {
      grantId,
      usageId: `use-${grantId}`,
      operation: "request_token",
      resource: scopeKey,
    }, {
      correlationId: runId,
      causationId: tokenEvent.id,
      seq: 1,
    });
    auditEvents.push(tokenEvent, usedEvent);
    return {
      ok: true,
      executed: true,
      decision,
      tokenEvent,
      credential: {
        tokenRef: `token-ref://${grantId}`,
        expiresAt: "2026-06-28T00:00:00.000Z",
        scope,
      },
    };
  }

  function observeToolResult(input = {}) {
    const runId = requireString(input.runId, "runId");
    const subject = normalizeAgentSubject(input.subject);
    const sourceToolName = requireString(input.sourceToolName, "sourceToolName");
    return deepFreeze({
      schema: MCP_HARDENING_CONTRACT_VERSION,
      runId,
      subject: principalForPolicy(subject),
      sourceToolName,
      trustedAsCommand: false,
      derivedToolCalls: [],
      textDigest: sha256Digest(input.text ?? ""),
      rule: "tool descriptions and results are untrusted data",
    });
  }

  function resolveApprovalHook(input = {}) {
    const hookId = requireString(input.hookId, "hookId");
    const hook = approvalHooks.get(hookId);
    if (!hook) {
      return { ok: false, reason: `unknown approval hook ${hookId}` };
    }
    const approver = normalizePrincipalRef(input.approver, "approver");
    if (approver.id === hook.requester.id) {
      return { ok: false, reason: "requester cannot approve its own gated action" };
    }
    const roles = normalizeStringArray(input.approver.roles ?? [], "approver.roles");
    if (!roles.includes(hook.requiredRole)) {
      return { ok: false, reason: `approval requires ${hook.requiredRole}` };
    }
    const event = deepFreeze({
      id: `${hookId}:approval-satisfied`,
      type: "policy.ApprovalSatisfied",
      schemaVersion: POLICY_IR_SCHEMA_VERSION,
      correlationId: hook.runId,
      hookId,
      requester: hook.requester,
      approver: { ...approver, roles },
    });
    auditEvents.push(event);
    approvalHooks.set(hookId, { ...hook, status: "satisfied", approver });
    return { ok: true, event };
  }

  function revokeGrant(input = {}) {
    const runId = requireString(input.runId, "runId");
    const subjectId = requireString(input.subjectId, "subjectId");
    const grantId = requireString(input.grantId, "grantId");
    revokedGrants.add(revocationKey({ id: subjectId, grantId }));
    const event = createValidatedIdentityEvent("token.Revoked", {
      grantId,
      reason: requireString(input.reason, "reason"),
      subjectId,
    }, {
      correlationId: runId,
      causationId: grantId,
    });
    auditEvents.push(event);
    return event;
  }

  function recordDecision({
    runId,
    subject,
    toolName,
    tool,
    effect,
    reason,
    context = {},
    approvals = [],
    obligations = [],
    violations = [],
    policyIds,
  }) {
    const request = createDecisionRequest({
      schemaVersion: POLICY_IR_SCHEMA_VERSION,
      subject: principalForPolicy(subject),
      action: "agent.tool.call",
      resource: tool?.resource ?? { kind: "mcp-tool", id: toolName },
      phase: tool?.phase ?? "runtime",
      context: {
        mcp: {
          toolName,
          contractVersion: MCP_HARDENING_CONTRACT_VERSION,
        },
        ...context,
      },
    });
    const decision = createDecision(request, {
      effect,
      reason,
      violations,
      approvals,
      obligations,
      evidence: {
        engine: MCP_HARDENING_ENGINE_ID,
        policyIds: policyIds ?? ["mcp/deny-by-default"],
      },
    });
    const event = createPolicyDecidedEvent({
      request,
      decision,
      id: `policy-decided-${runId}-${toolName}-${auditEvents.length + 1}`,
    });
    event.correlationId = runId;
    event.causationId = `${runId}:${toolName}`;
    event.runId = runId;
    event.toolName = toolName;
    auditEvents.push(event);
    return decision;
  }

  function createApprovalHook({ runId, subject, toolName, tool, input }) {
    const hook = deepFreeze({
      id: `hook-${++hookSequence}`,
      kind: "createHook",
      runId,
      toolName,
      requester: { kind: subject.kind, id: subject.id },
      requiredRole: tool.approvalRole ?? "Deployer",
      input: cloneJson(input),
      status: "pending",
    });
    approvalHooks.set(hook.id, hook);
    return hook;
  }

  function getAuditEvents() {
    return auditEvents.map((event) => cloneJson(event));
  }

  return Object.freeze({
    invokeTool,
    observeToolResult,
    resolveApprovalHook,
    revokeGrant,
    getAuditEvents,
  });
}

export function reconstructAuditChain(events, runId) {
  const relevant = events.filter((event) => event.correlationId === runId || event.runId === runId);
  const policyEvents = relevant.filter((event) => event.type === "policy.Decided");
  const identityEvents = relevant.filter((event) => event.type?.startsWith("token."));
  const firstSubject =
    policyEvents[0]?.subject ??
    identityEvents.find((event) => event.data?.subject)?.data.subject ??
    null;

  return deepFreeze({
    runId,
    user: firstSubject?.delegatedBy ?? null,
    agent: firstSubject ? { kind: firstSubject.kind, id: firstSubject.id } : null,
    actions: policyEvents.map((event) => ({
      toolName: event.toolName,
      effect: event.data.effect,
      action: event.action,
      resource: event.resource,
      evidence: event.data.evidence,
    })),
    tokenGrants: identityEvents.filter((event) => event.type === "token.Granted"),
    tokenDenials: identityEvents.filter((event) => event.type === "token.Denied"),
    tokenRevocations: identityEvents.filter((event) => event.type === "token.Revoked"),
  });
}

function reserveSpend({ runId, subject, tool, spendByRunAndSubject }) {
  const cost = tool.costCents ?? 0;
  const key = `${runId}:${subject.id}`;
  const used = spendByRunAndSubject.get(key) ?? 0;
  const next = used + cost;
  if (subject.spendCapCents > 0 && next > subject.spendCapCents) {
    return {
      ok: false,
      reason: `agent spend cap exceeded: ${next}c > ${subject.spendCapCents}c`,
      context: { spend: { usedCents: used, requestedCents: cost, capCents: subject.spendCapCents } },
    };
  }
  spendByRunAndSubject.set(key, next);
  return { ok: true };
}

function isExactTokenScopeAllowed(subject, scopeKey) {
  if (scopeKey.includes("*") || scopeKey.includes(":admin") || scopeKey.includes(":manage")) {
    return false;
  }
  return subject.scopes.includes(`token:${scopeKey}`);
}

function tokenScopeKey(provider, scope) {
  return `${provider}:${scope.port}:${scope.resource}:${scope.action}`;
}

function normalizeTokenScope(input) {
  const source = expectObject(input, "input.scope");
  return {
    port: requireString(source.port, "input.scope.port"),
    resource: requireString(source.resource, "input.scope.resource"),
    action: requireString(source.action, "input.scope.action"),
  };
}

function executeFixtureTool({ toolName, input }) {
  if (toolName === "tail_logs") {
    return {
      text: String(input.fixtureOutput ?? ""),
      trustedAsCommand: false,
    };
  }
  return {
    ok: true,
    toolName,
    fixture: true,
  };
}

function createValidatedIdentityEvent(type, data, overrides) {
  const event = createIdentityEvent(type, data, {
    time: "2026-06-27T23:50:00.000Z",
    actor: { kind: "service", id: "yard/identity" },
    ...overrides,
  });
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid identity event ${type}: ${validation.errors.join("; ")}`);
  }
  return event;
}

function denyResult(decision) {
  return {
    ok: false,
    executed: false,
    decision,
  };
}

function isProdTarget(input) {
  return input?.camp === "prod" || input?.environment === "prod" || input?.target === "prod";
}

function revocationKey(subject) {
  return `${subject.id}:${subject.grantId}`;
}

function principalForPolicy(subject) {
  return {
    kind: subject.kind,
    id: subject.id,
    roles: [...subject.roles],
    scopes: [...subject.scopes],
    delegatedBy: cloneJson(subject.delegatedBy),
  };
}

function principalForIdentityEvent(subject) {
  return {
    kind: subject.kind,
    id: subject.id,
    delegatedBy: cloneJson(subject.delegatedBy),
  };
}

function normalizeAgentSubject(input) {
  const source = expectObject(input, "subject");
  return {
    kind: source.kind ?? "agent",
    id: requireString(source.id, "subject.id"),
    delegatedBy: normalizePrincipalRef(source.delegatedBy, "subject.delegatedBy"),
    grantId: requireString(source.grantId, "subject.grantId"),
    roles: normalizeStringArray(source.roles ?? [], "subject.roles"),
    scopes: normalizeStringArray(source.scopes ?? [], "subject.scopes"),
    spendCapCents: normalizeNonNegativeNumber(source.spendCapCents ?? 0, "subject.spendCapCents"),
  };
}

function normalizePrincipalRef(input, path) {
  const source = expectObject(input, path);
  const normalized = {
    kind: requireString(source.kind, `${path}.kind`),
    id: requireString(source.id, `${path}.id`),
  };
  if (source.roles) normalized.roles = normalizeStringArray(source.roles, `${path}.roles`);
  return normalized;
}

function normalizeStringArray(input, path) {
  if (!Array.isArray(input)) {
    throw new TypeError(`${path} must be an array`);
  }
  return input.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function requireString(input, path) {
  if (!isString(input) || input.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return input;
}

function normalizeNonNegativeNumber(input, path) {
  if (!Number.isFinite(input) || input < 0) {
    throw new TypeError(`${path} must be a non-negative finite number`);
  }
  return input;
}

function expectObject(input, path) {
  if (!isRecord(input)) {
    throw new TypeError(`${path} must be an object`);
  }
  return input;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return value;
}

function isRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}


function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}
