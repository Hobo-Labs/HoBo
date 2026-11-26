import { isJsonString, isJsonObject } from "./json.js";
const POLICY_ALLOW_EFFECTS = new Set(["allow", "warn"]);
const POLICY_DENY_EFFECTS = new Set(["deny", "require-approval"]);

export function createOperatorPortRegistry() {
  const issueTrackers = new Map();
  const knowledgeAdapters = new Map();

  const registry = {
    registerIssueTracker(adapter) {
      validateAdapter(adapter, "issue-tracker", "syncIncident");
      assertUnique(issueTrackers, adapter.id, "issue-tracker");
      issueTrackers.set(adapter.id, adapter);
      return registry;
    },
    registerKnowledge(adapter) {
      validateAdapter(adapter, "knowledge", "publish");
      assertUnique(knowledgeAdapters, adapter.id, "knowledge");
      knowledgeAdapters.set(adapter.id, adapter);
      return registry;
    },
    getIssueTracker(id) {
      return issueTrackers.get(id);
    },
    getKnowledge(id) {
      return knowledgeAdapters.get(id);
    },
  };

  return registry;
}

export function createIssueTrackerAdapter({ id, provider, ticketPrefix, failFirstFor = [] }) {
  validateNonEmptyString(id, "id");
  validateNonEmptyString(provider, "provider");
  validateNonEmptyString(ticketPrefix, "ticketPrefix");

  const failedOnce = new Set();
  const shouldFailFirst = new Set(failFirstFor);
  const ticketsByIdempotencyKey = new Map();
  const writes = [];

  return {
    id,
    kind: "issue-tracker",
    provider,
    writes,
    async syncIncident({ incident, idempotencyKey }) {
      const normalizedIncident = normalizeIncident(incident);
      validateNonEmptyString(idempotencyKey, "idempotencyKey");
      writes.push(deepFreeze({ incident: normalizedIncident, idempotencyKey }));

      if (shouldFailFirst.has(idempotencyKey) && !failedOnce.has(idempotencyKey)) {
        failedOnce.add(idempotencyKey);
        throw new Error(`external issue-tracker write failed for ${idempotencyKey}`);
      }

      if (!ticketsByIdempotencyKey.has(idempotencyKey)) {
        const sequence = String(ticketsByIdempotencyKey.size + 1).padStart(4, "0");
        ticketsByIdempotencyKey.set(
          idempotencyKey,
          deepFreeze({
            provider,
            id: `${ticketPrefix}-${sequence}`,
            url: `https://${provider}.example/${ticketPrefix}-${sequence}`,
            title: normalizedIncident.title,
          }),
        );
      }

      return ticketsByIdempotencyKey.get(idempotencyKey);
    },
  };
}

export function createKnowledgeAdapter({ id, provider, baseUrl }) {
  validateNonEmptyString(id, "id");
  validateNonEmptyString(provider, "provider");
  validateNonEmptyString(baseUrl, "baseUrl");

  const publishes = [];

  return {
    id,
    kind: "knowledge",
    provider,
    publishes,
    async publish({ document, target, idempotencyKey }) {
      const normalizedDocument = normalizeDocument(document);
      const normalizedTarget = normalizeKnowledgeTarget(target);
      validateNonEmptyString(idempotencyKey, "idempotencyKey");
      const publication = deepFreeze({
        provider,
        id: `${normalizedTarget.space}/${normalizedDocument.id}`,
        url: joinUrl(baseUrl, normalizedTarget.space, normalizedDocument.id),
        visibility: normalizedTarget.visibility,
      });

      publishes.push(
        deepFreeze({
          document: normalizedDocument,
          target: normalizedTarget,
          idempotencyKey,
          publication,
        }),
      );

      return publication;
    },
  };
}

export function createOperatorIntegrationRuntime(registry, config) {
  if (!registry || !(registry.getIssueTracker instanceof Function) || !(registry.getKnowledge instanceof Function)) {
    throw new Error("registry must be created with createOperatorPortRegistry()");
  }

  const issueAdapterId = config?.issueTracker;
  const knowledgeAdapterId = config?.knowledge;
  const incidentLinks = new Map();
  const pendingIssueWrites = new Map();
  const eventLog = [];

  return {
    async syncIncidentToTicket(input = {}) {
      const operation = normalizeIssueOperation(input, { registry, issueAdapterId });
      return applyIssueWrite(operation);
    },
    async retryPendingIssueWrite(idempotencyKey) {
      validateNonEmptyString(idempotencyKey, "idempotencyKey");
      const operation = pendingIssueWrites.get(idempotencyKey);
      if (!operation) {
        throw new Error(`no pending issue-tracker write for ${idempotencyKey}`);
      }

      return applyIssueWrite(operation);
    },
    async publishKnowledge(input = {}) {
      const operation = normalizeKnowledgeOperation(input, { registry, knowledgeAdapterId });
      const policyEvent = cloneFrozen(operation.policyDecision);
      const deniedReason = knowledgeDenyReason(operation);

      if (deniedReason) {
        const denied = crewActionEvent("crew.ActionDenied", operation, {
          reason: deniedReason,
        });
        eventLog.push(policyEvent, denied);
        throw new Error(`policy denied knowledge publish: ${deniedReason}`);
      }

      const publication = await operation.adapter.publish({
        document: operation.document,
        target: operation.target,
        idempotencyKey: operation.idempotencyKey,
      });
      const applied = crewActionEvent("crew.ActionApplied", operation, {
        result: {
          publicationUrl: publication.url,
          publicationId: publication.id,
        },
      });
      eventLog.push(policyEvent, applied);

      return deepFreeze({
        publication,
        events: [policyEvent, applied],
      });
    },
    getIncidentLink(incidentId) {
      validateNonEmptyString(incidentId, "incidentId");
      return incidentLinks.get(incidentId) ?? null;
    },
    getEventLog() {
      return Object.freeze([...eventLog]);
    },
  };

  async function applyIssueWrite(operation) {
    const deniedReason = issueDenyReason(operation);
    const policyEvent = cloneFrozen(operation.policyDecision);

    if (deniedReason) {
      const denied = crewActionEvent("crew.ActionDenied", operation, { reason: deniedReason });
      eventLog.push(policyEvent, denied);
      throw new Error(`policy denied issue-tracker write: ${deniedReason}`);
    }

    pendingIssueWrites.set(operation.idempotencyKey, operation);
    incidentLinks.set(
      operation.incident.id,
      deepFreeze({
        incidentId: operation.incident.id,
        status: "pending",
        idempotencyKey: operation.idempotencyKey,
        adapterId: operation.adapter.id,
      }),
    );

    let ticket;
    try {
      ticket = await operation.adapter.syncIncident({
        incident: operation.incident,
        idempotencyKey: operation.idempotencyKey,
      });
    } catch (error) {
      throw new Error(`external issue-tracker write failed for ${operation.idempotencyKey}: ${error.message}`);
    }

    const link = deepFreeze({
      incidentId: operation.incident.id,
      status: "linked",
      idempotencyKey: operation.idempotencyKey,
      adapterId: operation.adapter.id,
      ticket,
    });
    incidentLinks.set(operation.incident.id, link);
    pendingIssueWrites.delete(operation.idempotencyKey);

    const applied = crewActionEvent("crew.ActionApplied", operation, {
      result: {
        ticketUrl: ticket.url,
        ticketId: ticket.id,
      },
    });
    eventLog.push(policyEvent, applied);

    return deepFreeze({
      link,
      events: [policyEvent, applied],
    });
  }
}

function normalizeIssueOperation(input, { registry, issueAdapterId }) {
  const adapter = registry.getIssueTracker(issueAdapterId);
  if (!adapter) {
    throw new Error(`unregistered issue-tracker adapter ${String(issueAdapterId)}`);
  }
  const incident = normalizeIncident(input.incident);
  const action = normalizeAction(input.action);
  const policyDecision = normalizePolicyDecision(input.policyDecision);

  return Object.freeze({
    port: "issue-tracker",
    adapter,
    incident,
    policyDecision,
    action,
    idempotencyKey: `${incident.id}:${action.id}`,
    correlationId: incident.id,
  });
}

function normalizeKnowledgeOperation(input, { registry, knowledgeAdapterId }) {
  const adapter = registry.getKnowledge(knowledgeAdapterId);
  if (!adapter) {
    throw new Error(`unregistered knowledge adapter ${String(knowledgeAdapterId)}`);
  }
  const document = normalizeDocument(input.document);
  const target = normalizeKnowledgeTarget(input.target);
  const action = normalizeAction(input.action);
  const policyDecision = normalizePolicyDecision(input.policyDecision);

  return Object.freeze({
    port: "knowledge",
    adapter,
    document,
    target,
    policyDecision,
    action,
    idempotencyKey: `${document.id}:${action.id}`,
    correlationId: document.incidentId ?? document.id,
  });
}

function normalizeIncident(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new Error("incident must be an object");
  }

  return deepFreeze({
    id: validateNonEmptyString(input.id, "incident.id"),
    title: validateNonEmptyString(input.title, "incident.title"),
    severity: validateNonEmptyString(input.severity, "incident.severity"),
    service: validateNonEmptyString(input.service, "incident.service"),
  });
}

function normalizeDocument(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new Error("document must be an object");
  }

  return deepFreeze({
    id: validateNonEmptyString(input.id, "document.id"),
    type: validateMember(input.type, new Set(["postmortem", "runbook"]), "document.type"),
    incidentId: input.incidentId ? validateNonEmptyString(input.incidentId, "document.incidentId") : undefined,
    title: validateNonEmptyString(input.title, "document.title"),
    body: validateNonEmptyString(input.body, "document.body"),
    classification: validateMember(
      input.classification,
      new Set(["public", "internal", "internal-only"]),
      "document.classification",
    ),
  });
}

function normalizeKnowledgeTarget(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new Error("target must be an object");
  }

  return deepFreeze({
    space: validateNonEmptyString(input.space, "target.space"),
    visibility: validateMember(input.visibility, new Set(["public", "internal"]), "target.visibility"),
  });
}

function normalizePolicyDecision(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new Error("policyDecision must be an object");
  }
  if (input.type !== "policy.Decided") {
    throw new Error("policyDecision.type must be policy.Decided");
  }
  const effect = validateMember(input.data?.effect, new Set([...POLICY_ALLOW_EFFECTS, ...POLICY_DENY_EFFECTS]), "effect");

  return deepFreeze({
    id: validateNonEmptyString(input.id, "policyDecision.id"),
    type: "policy.Decided",
    v: input.v ?? 1,
    streamId: validateNonEmptyString(input.streamId, "policyDecision.streamId"),
    seq: validateSeq(input.seq, "policyDecision.seq"),
    ts: validateIso(input.ts, "policyDecision.ts"),
    data: {
      effect,
      ...(input.data?.reason ? { reason: validateNonEmptyString(input.data.reason, "policyDecision.data.reason") } : undefined),
    },
  });
}

function normalizeAction(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new Error("action must be an object");
  }

  return deepFreeze({
    id: validateNonEmptyString(input.id, "action.id"),
    streamId: validateNonEmptyString(input.streamId, "action.streamId"),
    seq: validateSeq(input.seq, "action.seq"),
    ts: validateIso(input.ts, "action.ts"),
    principal: normalizePrincipal(input.principal),
    kind: validateNonEmptyString(input.kind, "action.kind"),
    target: validateNonEmptyString(input.target, "action.target"),
  });
}

function normalizePrincipal(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new Error("principal must be an object");
  }
  const svid = validateNonEmptyString(input.svid, "principal.svid");
  if (!svid.startsWith("spiffe://")) {
    throw new Error("principal.svid must be a SPIFFE URI");
  }

  return deepFreeze({
    name: validateNonEmptyString(input.name, "principal.name"),
    svid,
  });
}

function issueDenyReason({ policyDecision }) {
  if (POLICY_DENY_EFFECTS.has(policyDecision.data.effect)) {
    return policyDecision.data.reason ?? `policy.Decided(${policyDecision.data.effect})`;
  }
  return null;
}

function knowledgeDenyReason({ document, target, policyDecision }) {
  if (POLICY_DENY_EFFECTS.has(policyDecision.data.effect)) {
    return policyDecision.data.reason ?? `policy.Decided(${policyDecision.data.effect})`;
  }
  if (document.classification === "internal-only" && target.visibility === "public") {
    return "internal-only content cannot publish to public spaces";
  }
  return null;
}

function crewActionEvent(type, operation, { result, reason } = {}) {
  return deepFreeze({
    id: `${type === "crew.ActionApplied" ? "applied" : "denied"}-${slug(operation.action.id)}`,
    type,
    v: 1,
    streamId: operation.action.streamId,
    seq: operation.action.seq + 1,
    ts: operation.action.ts,
    principal: operation.action.principal,
    correlationId: operation.correlationId,
    causationId: operation.action.id,
    data: {
      proposalId: operation.action.id,
      policyDecisionId: operation.policyDecision.id,
      action: {
        kind: operation.action.kind,
        target: operation.action.target,
      },
      port: operation.port,
      adapterId: operation.adapter.id,
      idempotencyKey: operation.idempotencyKey,
      ...(result ? { result } : undefined),
      ...(reason ? { reason } : undefined),
    },
  });
}

function validateAdapter(adapter, kind, method) {
  if (!adapter || !isJsonObject(adapter) || Array.isArray(adapter)) {
    throw new Error(`${kind} adapter must be an object`);
  }
  validateNonEmptyString(adapter.id, `${kind} adapter id`);
  if (adapter.kind !== kind) {
    throw new Error(`adapter ${adapter.id} must have kind ${kind}`);
  }
  if (!(adapter[method] instanceof Function)) {
    throw new Error(`adapter ${adapter.id} must implement ${method}()`);
  }
}

function assertUnique(adapters, id, kind) {
  if (adapters.has(id)) {
    throw new Error(`${kind} adapter ${id} is already registered`);
  }
}

function validateNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function validateMember(value, allowed, fieldName) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${fieldName}: ${String(value)}`);
  }
  return value;
}

function validateSeq(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function validateIso(value, fieldName) {
  const text = validateNonEmptyString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function cloneFrozen(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function joinUrl(baseUrl, ...parts) {
  return [baseUrl.replace(/\/+$/g, ""), ...parts.map((part) => encodeURIComponent(part))].join("/");
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
