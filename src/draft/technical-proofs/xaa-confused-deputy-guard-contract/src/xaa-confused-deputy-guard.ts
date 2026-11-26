import { isJsonString, isJsonObject } from "./json.js";
import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  POLICY_IR_SCHEMA_VERSION,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { createOutboundXaaTokenBroker } from "../../outbound-xaa-token-exchange-contract/src/outbound-xaa-token-exchange.js";

export const XAA_CONFUSED_DEPUTY_GUARD_VERSION = "hobo.xaa-confused-deputy-guard/v1";

const DEFAULT_EVENT_ACTOR = { kind: "service", id: "yard/identity" };
const POLICY_ENGINE_ID = "hobo.xaa-confused-deputy-guard@0.1.0";

export function createXaaConfusedDeputyGuard(options = {}) {
  const issuer = requireString(options.issuer ?? "https://identity.hobo.test", "issuer");
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory();
  const grants = normalizeGrants(options.grants ?? []);
  const targetAuthorizationServers = options.targetAuthorizationServers ;
  const eventSink = options.eventSink ?? (() => {});

  return Object.freeze({
    async exchangeOutboundXaa(input) {
      const request = normalizeGuardRequest(input);
      const canonicalSubject = canonicalSubjectFor(request);

      const verifiedDecision = verifyDelegatedSubject(request, canonicalSubject);
      if (!verifiedDecision.ok) {
        return denied({ request, subject: canonicalSubject, decision: verifiedDecision, now, eventSink });
      }

      const grantDecision = decideDelegatedGrant({
        request,
        subject: canonicalSubject,
        grants,
      });
      const policyEvent = policyDecided({
        request,
        subject: canonicalSubject,
        effect: grantDecision.effect,
        reason: grantDecision.reason,
        policyIds: grantDecision.policyIds,
        violations: grantDecision.violations,
      });

      if (grantDecision.effect !== "allow") {
        const tokenEvent = tokenDenied({
          request,
          subject: canonicalSubject,
          reason: grantDecision.reason,
          now,
          seq: 2,
          causationId: policyEvent.id,
        });
        emitEvents(eventSink, [policyEvent, tokenEvent]);
        return {
          ok: false,
          requestId: request.requestId,
          reason: grantDecision.reason,
          target: { kind: "external-app", id: request.target.id },
          events: [policyEvent, tokenEvent],
        };
      }

      const broker = createOutboundXaaTokenBroker({
        issuer,
        now,
        idFactory,
        targetAuthorizationServers,
        preMintPolicy: async () => ({ ok: true }),
      });
      const brokerResult = await broker.exchangeToken({
        requestId: request.requestId,
        subject: canonicalSubject,
        subjectToken: request.subjectToken,
        target: request.target,
        requestedScopes: request.requestedScopes,
      });
      const events = [policyEvent, ...brokerResult.events];
      emitEvents(eventSink, events);
      return { ...brokerResult, events };
    },
  });
}

function verifyDelegatedSubject(request, canonicalSubject) {
  if (!request.verifiedDelegatedBy) {
    return {
      ok: false,
      effect: "deny",
      reason: "verifiedDelegatedBy is required before minting ID-JAG",
      policyIds: ["policy:xaa-verified-delegation-required"],
      violations: ["missing verifiedDelegatedBy principal"],
    };
  }

  if (request.verifiedDelegatedBy.kind !== "user") {
    return {
      ok: false,
      effect: "deny",
      reason: "verifiedDelegatedBy.kind must be user before minting ID-JAG",
      policyIds: ["policy:xaa-verified-delegation-required"],
      violations: [`verifiedDelegatedBy ${principalKey(request.verifiedDelegatedBy)} is not a user`],
    };
  }

  const claimed = request.subject.delegatedBy;
  if (claimed && !samePrincipal(claimed, request.verifiedDelegatedBy)) {
    return {
      ok: false,
      effect: "deny",
      reason: `subject.delegatedBy ${principalKey(claimed)} does not match verified delegated user ${principalKey(
        request.verifiedDelegatedBy,
      )}`,
      policyIds: ["policy:xaa-verified-delegation-required"],
      violations: [
        `forged delegatedBy ${principalKey(claimed)} rejected for ${principalKey(canonicalSubject)}`,
      ],
    };
  }

  return { ok: true };
}

function decideDelegatedGrant({ request, subject, grants }) {
  const grant = grants.find(
    (candidate) =>
      candidate.agentId === subject.id &&
      candidate.userId === subject.delegatedBy.id &&
      candidate.targetId === request.target.id &&
      isSubset(request.requestedScopes, candidate.scopes),
  );
  if (grant) {
    return {
      effect: "allow",
      reason: `delegated grant permits ${subject.id} for ${subject.delegatedBy.id} on ${request.target.id}`,
      policyIds: ["policy:xaa-delegated-grant"],
      violations: [],
    };
  }

  return {
    effect: "deny",
    reason: `no delegated grant permits ${subject.id} for ${subject.delegatedBy.id} on ${request.target.id}`,
    policyIds: ["policy:xaa-deny-by-default"],
    violations: [
      `missing delegated grant for ${subject.id}/${subject.delegatedBy.id}/${request.target.id}`,
    ],
  };
}

function denied({ request, subject, decision, now, eventSink }) {
  const policyEvent = policyDecided({
    request,
    subject,
    effect: "deny",
    reason: decision.reason,
    policyIds: decision.policyIds,
    violations: decision.violations,
  });
  const tokenEvent = tokenDenied({
    request,
    subject,
    reason: decision.reason,
    now,
    seq: 2,
    causationId: policyEvent.id,
  });
  emitEvents(eventSink, [policyEvent, tokenEvent]);

  return {
    ok: false,
    requestId: request.requestId,
    reason: decision.reason,
    target: { kind: "external-app", id: request.target.id },
    events: [policyEvent, tokenEvent],
  };
}

function policyDecided({ request, subject, effect, reason, policyIds, violations }) {
  const policyRequest = createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: toPolicySubject(subject),
    action: "token.mintIdJag",
    resource: { kind: "external-app", id: request.target.id },
    phase: "runtime",
    context: {
      requestId: request.requestId,
      audience: request.target.audience,
      resource: request.target.resource,
      requestedScopes: request.requestedScopes,
      verifiedDelegatedBy: request.verifiedDelegatedBy
        ? principalKey(request.verifiedDelegatedBy)
        : null,
    },
  });
  const decision = createDecision(policyRequest, {
    effect,
    reason,
    violations,
    evidence: { policyIds, engine: POLICY_ENGINE_ID },
  });
  return createPolicyDecidedEvent({
    request: policyRequest,
    decision,
    id: `evt-${request.requestId}-policy`,
  });
}

function tokenDenied({ request, subject, reason, now, seq, causationId }) {
  const event = createIdentityEvent(
    "token.Denied",
    {
      requestId: request.requestId,
      subject,
      target: { kind: "external-app", id: request.target.id },
      reason,
    },
    {
      id: `evt-${request.requestId}-denied`,
      time: now().toISOString(),
      actor: DEFAULT_EVENT_ACTOR,
      seq,
      correlationId: request.requestId,
      causationId,
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid token.Denied event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function normalizeGuardRequest(input) {
  assertObject(input, "exchange request");
  const target = normalizeTarget(input.target, "target");
  return {
    requestId: requireString(input.requestId, "requestId"),
    subject: normalizePrincipal(input.subject, "subject"),
    verifiedDelegatedBy:
      input.verifiedDelegatedBy === undefined
        ? undefined
        : normalizePrincipal(input.verifiedDelegatedBy, "verifiedDelegatedBy"),
    subjectToken: normalizeSubjectToken(input.subjectToken),
    target,
    requestedScopes: normalizeScopes(input.requestedScopes, {
      allowedScopes: target.allowedScopes,
      field: "requestedScopes",
    }),
  };
}

function canonicalSubjectFor(request) {
  const subject = {
    kind: request.subject.kind,
    id: request.subject.id,
  };
  if (request.verifiedDelegatedBy?.kind === "user") {
    subject.delegatedBy = request.verifiedDelegatedBy;
  }
  return subject;
}

function normalizeGrants(grants) {
  if (!Array.isArray(grants)) {
    throw new Error("grants must be an array");
  }
  return grants.map((grant, index) => {
    assertObject(grant, `grants[${index}]`);
    return {
      agentId: requireString(grant.agentId, `grants[${index}].agentId`),
      userId: requireString(grant.userId, `grants[${index}].userId`),
      targetId: requireString(grant.targetId, `grants[${index}].targetId`),
      scopes: normalizeScopes(grant.scopes, { field: `grants[${index}].scopes` }),
    };
  });
}

function normalizeTarget(value, field) {
  assertObject(value, field);
  const allowedScopes = normalizeScopes(value.allowedScopes, { field: `${field}.allowedScopes` });
  assertObject(value.authFlow, `${field}.authFlow`);

  return {
    id: requireString(value.id, `${field}.id`),
    audience: requireString(value.audience, `${field}.audience`),
    resource: requireString(value.resource, `${field}.resource`),
    allowedScopes,
    authFlow: {
      type: requireString(value.authFlow.type, `${field}.authFlow.type`),
      targetAuthorizationServer:
        value.authFlow.targetAuthorizationServer === undefined
          ? undefined
          : requireString(
              value.authFlow.targetAuthorizationServer,
              `${field}.authFlow.targetAuthorizationServer`,
            ),
    },
  };
}

function normalizeSubjectToken(value) {
  assertObject(value, "subjectToken");
  return {
    tokenRef: requireString(value.tokenRef, "subjectToken.tokenRef"),
    tokenType: requireString(value.tokenType, "subjectToken.tokenType"),
  };
}

function normalizePrincipal(value, field) {
  assertObject(value, field);
  const principal = {
    kind: requireString(value.kind, `${field}.kind`),
    id: requireString(value.id, `${field}.id`),
  };
  if (value.delegatedBy !== undefined) {
    principal.delegatedBy = normalizePrincipal(value.delegatedBy, `${field}.delegatedBy`);
  }
  return principal;
}

function toPolicySubject(subject) {
  const policySubject = {
    kind: subject.kind,
    id: subject.id,
  };
  if (subject.delegatedBy) {
    policySubject.delegatedBy = {
      kind: subject.delegatedBy.kind,
      id: subject.delegatedBy.id,
    };
  }
  return policySubject;
}

function normalizeScopes(scopes, { allowedScopes, field } = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(`${field ?? "scopes"} must be a non-empty array`);
  }
  const seen = new Set();
  const normalized = scopes.map((scope, index) => {
    const value = requireString(scope, `${field ?? "scopes"}[${index}]`);
    if (/\s/.test(value)) {
      throw new Error(`${field ?? "scopes"}[${index}] must not contain whitespace`);
    }
    if (seen.has(value)) {
      throw new Error(`duplicate scope '${value}'`);
    }
    seen.add(value);
    return value;
  });
  if (allowedScopes !== undefined) {
    const allowed = new Set(normalizeScopes(allowedScopes, { field: "allowedScopes" }));
    for (const scope of normalized) {
      if (!allowed.has(scope)) {
        throw new Error(`scope '${scope}' is outside allowed scopes`);
      }
    }
  }
  return normalized.sort();
}

function isSubset(values, allowedValues) {
  const allowed = new Set(allowedValues);
  return values.every((value) => allowed.has(value));
}

function samePrincipal(left, right) {
  return left.kind === right.kind && left.id === right.id;
}

function principalKey(principal) {
  return `${principal.kind}:${principal.id.replace(/^(user|agent|service):/, "")}`;
}

function emitEvents(eventSink, events) {
  for (const event of events) {
    eventSink(event);
  }
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function assertObject(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
