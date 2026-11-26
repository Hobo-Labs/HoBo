import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const completedType = "bootstrap.Completed";
const attemptStartedType = "bootstrap.AttemptStarted";

export function createFakeProvider({ expireCredentialDuringApply = false, attemptEgress = false } = {}) {
  let provisioned = false;
  const calls = [];

  return {
    calls,
    plan({ mode }) {
      if (attemptEgress && mode === "airgap") {
        calls.push({ kind: "egress", egress: true, destination: "public-registry" });
        throw codedError("airgap-egress-attempt", "air-gapped bootstrap attempted public egress");
      }

      calls.push({ kind: "plan", egress: false, changes: !provisioned });
      return {
        id: "plan-yard-bindle",
        changes: !provisioned,
        resources: yardResources(),
      };
    },
    reconcile({ credential, plan }) {
      calls.push({
        kind: "reconcile",
        egress: false,
        credentialId: credential.id,
        planId: plan.id,
      });

      if (expireCredentialDuringApply) {
        throw codedError("operator-credential-expired-mid-apply", "operator bootstrap credential expired mid-apply");
      }

      provisioned = true;
      return {
        setRef: "set:yard@sha256-bootstrap",
        resources: yardResources(),
      };
    },
  };
}

export function createFakeIdentity({ federated = true } = {}) {
  const calls = [];

  return {
    calls,
    canBrokerYardToken({ targetYard }) {
      calls.push({ kind: "can-broker-yard-token", targetYard, federated });
      return federated;
    },
    brokerYardToken({ targetYard, targetCamp }) {
      calls.push({ kind: "broker-yard-token", targetYard, targetCamp, federated });
      if (!federated) {
        throw codedError("identity-not-federated", "real Identity is not federated");
      }
      return {
        id: `yard-token:${targetYard}:${targetCamp}`,
        principal: "yard-control-plane",
        issuer: "real-yard-identity",
      };
    },
  };
}

export function runHoboYardUp(input = {}) {
  const attemptId = requiredString(input.attemptId, "attemptId");
  const targetYard = requiredString(input.targetYard, "targetYard");
  const targetCamp = requiredString(input.targetCamp, "targetCamp");
  const mode = input.mode ?? "connected";
  if (!["connected", "airgap"].includes(mode)) {
    throw new TypeError("mode must be connected or airgap");
  }

  const now = input.now ?? new Date(0).toISOString();
  const previousEvents = Array.isArray(input.previousEvents) ? input.previousEvents : [];
  const provider = input.provider ?? createFakeProvider();
  const identity = input.identity ?? createFakeIdentity({ federated: true });
  const credential = normalizeCredential(input.operatorCredential, { targetYard, targetCamp });
  let targetState = clone(input.targetState ?? deriveTargetState(previousEvents));
  let importedSeedLog = null;
  let retry = { requiresOperatorRelogin: false };
  const events = [];

  const existingAttempt = previousEvents.find((event) => event.type === attemptStartedType)?.data?.attemptId;
  if (existingAttempt && existingAttempt !== attemptId) {
    emit("bootstrap.Blocked", {
      reason: "target-yard-already-has-a-different-bootstrap-attempt",
      existingAttemptId: existingAttempt,
      incomingAttemptId: attemptId,
      targetYard,
      targetCamp,
    });
    return finish("blocked", "target-yard-already-has-a-different-bootstrap-attempt");
  }

  if (has(completedType)) {
    return finish("noop");
  }

  if (!has(attemptStartedType)) {
    emit(attemptStartedType, { attemptId, targetYard, targetCamp, mode });
  }

  if (!has("seed.Started")) {
    emit("seed.Started", {
      runtime: "@hobo/runtime-local",
      eventStore: "sqlite",
      disposable: true,
    });
  }

  if (!has("artifact.BundleVerified")) {
    if (mode === "airgap") {
      requiredString(input.offlineBundleDigest, "offlineBundleDigest");
      requiredString(input.inBoundaryTrustRoot, "inBoundaryTrustRoot");
    }
    emit("artifact.BundleVerified", {
      mode,
      yardBindle: "@hobo/sdk",
      offlineBundleDigest: input.offlineBundleDigest ?? null,
      inBoundaryTrustRoot: input.inBoundaryTrustRoot ?? null,
      egress: false,
    });
  }

  if (!has("identity.SeedTokenUsed")) {
    if (isExpired(credential.expiresAt, now)) {
      retry = { requiresOperatorRelogin: true };
      return block("operator-credential-expired-before-apply", {
        credentialId: credential.id,
        requiresOperatorRelogin: true,
      });
    }

    emit("identity.SeedTokenUsed", {
      credentialId: credential.id,
      subject: credential.subject,
      scope: credential.scope,
      singleUse: true,
      refreshable: false,
      auditEvent: "identity.SeedTokenUsed",
    });
  }

  if (!has("delta.Opened")) {
    emit("delta.Opened", {
      attemptId,
      targetYard,
      targetCamp,
      emptyTarget: !targetState.provisioned,
    });
  }

  if (!has("resource.Provisioned")) {
    if (!has("resource.Provisioning")) {
      emit("resource.Provisioning", {
        bindle: "@hobo/sdk",
        targetYard,
        targetCamp,
      });
    }

    try {
      const plan = provider.plan({ targetYard, targetCamp, mode, egressAllowed: false });
      const provisioned = provider.reconcile({
        targetYard,
        targetCamp,
        mode,
        credential,
        plan,
        now,
        egressAllowed: false,
      });
      targetState = freeze({
        provisioned: true,
        setRef: provisioned.setRef,
        resources: provisioned.resources,
      });
      emit("resource.Provisioned", {
        targetYard,
        targetCamp,
        setRef: provisioned.setRef,
        resources: provisioned.resources,
      });
    } catch (error) {
      const reason = error.code ?? "provider-apply-failed";
      retry = { requiresOperatorRelogin: reason === "operator-credential-expired-mid-apply" };
      return block(reason, {
        error: error.message,
        requiresOperatorRelogin: retry.requiresOperatorRelogin,
      });
    }

    if (input.crashAfterEvent === "resource.Provisioned") {
      return finish("interrupted", "seed-crash-after-resource-provisioned");
    }
  }

  if (!has("seedLog.Imported")) {
    const importedEvents = combinedEvents();
    importedSeedLog = buildImportedSeedLog(importedEvents, { attemptId, targetYard, targetCamp, mode });
    emit("seedLog.Imported", {
      seedLogHash: importedSeedLog.hash,
      replayMode: "read-only-provenance",
      liveCommandReplay: false,
      importedEventTypes: importedEvents.map((event) => event.type),
    });
  } else {
    importedSeedLog = recoverImportedSeedLog(combinedEvents(), { attemptId, targetYard, targetCamp, mode });
  }

  if (!has("identity.Issued")) {
    if (!identity.canBrokerYardToken({ targetYard, targetCamp })) {
      return block("identity-not-federated", {
        handoverTrigger: "real-identity-token-broker-ready",
        seedCredentialRetired: false,
      });
    }

    const token = identity.brokerYardToken({ targetYard, targetCamp });
    emit("identity.Issued", {
      tokenId: token.id,
      principal: token.principal,
      issuer: token.issuer,
      handoverTrigger: "real-identity-token-broker-ready",
    });
  }

  if (!has("token.Revoked")) {
    emit("token.Revoked", {
      credentialId: credential.id,
      reason: "real-identity-token-broker-ready",
    });
  }

  if (!has("seed.Discarded")) {
    emit("seed.Discarded", {
      attemptId,
      runtime: "@hobo/runtime-local",
    });
  }

  if (!has(completedType)) {
    emit(completedType, {
      attemptId,
      targetYard,
      targetCamp,
      seedDiscarded: true,
    });
  }

  return finish("completed");

  function has(type) {
    return combinedEvents().some((event) => event.type === type);
  }

  function emit(type, data = {}) {
    const seq = previousEvents.length + events.length + 1;
    events.push(
      freeze({
        id: `${attemptId}:${seq}:${type}`,
        seq,
        type,
        occurredAt: now,
        correlationId: `bootstrap:${attemptId}`,
        data: freeze({
          attemptId,
          ...data,
        }),
      }),
    );
  }

  function block(reason, data = {}) {
    emit("bootstrap.Blocked", {
      reason,
      targetYard,
      targetCamp,
      seedCredentialRetired: has("token.Revoked"),
      ...data,
    });
    return finish("blocked", reason);
  }

  function combinedEvents() {
    return [...previousEvents, ...events];
  }

  function finish(status, reason = null) {
    const allEvents = combinedEvents();
    importedSeedLog ??= recoverImportedSeedLog(allEvents, { attemptId, targetYard, targetCamp, mode });
    const egressAttempts = provider.calls.filter((call) => call.egress === true);

    return freeze({
      status,
      reason,
      events: clone(events),
      allEvents: clone(allEvents),
      targetState: clone(targetState),
      realYard: {
        importedSeedLog,
      },
      handover: {
        seedCredentialRetired: allEvents.some((event) => event.type === "token.Revoked"),
        brokeredByRealIdentity: allEvents.some((event) => event.type === "identity.Issued"),
      },
      retry,
      egressAttempts: clone(egressAttempts),
    });
  }
}

export function replayImportedSeedLog(importedSeedLog) {
  const events = Array.isArray(importedSeedLog?.events) ? importedSeedLog.events : [];
  const started = events.find((event) => event.type === attemptStartedType);
  const provisioned = events.find((event) => event.type === "resource.Provisioned");

  return freeze({
    attemptId: started?.data?.attemptId ?? null,
    targetYard: started?.data?.targetYard ?? null,
    targetCamp: started?.data?.targetCamp ?? null,
    seedTokenAudited: events.some((event) => event.type === "identity.SeedTokenUsed"),
    liveCommandReplay: importedSeedLog?.liveCommandReplay === true,
    provisionedResources: provisioned?.data?.resources ?? [],
  });
}

function normalizeCredential(raw = {}, { targetYard, targetCamp }) {
  return freeze({
    id: requiredString(raw.id ?? "operator-bootstrap-credential", "operatorCredential.id"),
    subject: requiredString(raw.subject ?? "spiffe://operator/bootstrap", "operatorCredential.subject"),
    scope: raw.scope ?? `bootstrap-apply:${targetYard}:${targetCamp}`,
    expiresAt: raw.expiresAt ?? "9999-12-31T23:59:59.999Z",
  });
}

function deriveTargetState(events) {
  const provisioned = [...events].reverse().find((event) => event.type === "resource.Provisioned");
  if (!provisioned) {
    return { provisioned: false, resources: [] };
  }

  return {
    provisioned: true,
    setRef: provisioned.data?.setRef,
    resources: provisioned.data?.resources ?? [],
  };
}

function buildImportedSeedLog(events, { attemptId, targetYard, targetCamp, mode }) {
  return freeze({
    attemptId,
    targetYard,
    targetCamp,
    hash: hashEvents(events),
    replayMode: "read-only-provenance",
    liveCommandReplay: false,
    airGapped: mode === "airgap",
    events: clone(events),
  });
}

function recoverImportedSeedLog(events, context) {
  const importEvent = events.find((event) => event.type === "seedLog.Imported");
  const importedEvents = importEvent
    ? events.slice(0, events.findIndex((event) => event.id === importEvent.id))
    : events.filter((event) => event.type !== "bootstrap.Blocked");
  return buildImportedSeedLog(importedEvents, context);
}

function yardResources() {
  return ["yard-gateway", "yard-identity", "yard-event-store"];
}

function hashEvents(events) {
  return createHash("sha256").update(JSON.stringify(sortKeys(events))).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

function isExpired(expiresAt, now) {
  return Date.parse(expiresAt) <= Date.parse(now);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${fieldName} is required`);
  }
  return value.trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}
