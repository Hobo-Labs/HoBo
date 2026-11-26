import { createHash } from "node:crypto";

import {
  createFakeIdentity,
  createFakeProvider,
  runHoboYardUp,
} from "../../../../technical-proofs/self-host-bootstrap-saga-contract/src/self-host-bootstrap-saga.js";
import { isJsonObject } from "./json.js";


export const DEVOPS_SELF_HOST_YARD_JOURNEY_VERSION = "hobo.devops-self-host-yard-journey/v1";

const DEFAULT_NOW = "2026-06-28T08:51:17.878Z";
const PLATFORM_PATH = "./platform";
const TARGET_YARD = "yard-prod";
const TARGET_CAMP = "host-azure";
const BASE_SET_REF = "set:yard@sha256-bootstrap";
const UPGRADE_SET_REF = "set:yard@sha256-upgrade-001";

export function runDevopsSelfHostYardJourney(input = {}) {
  const now = iso(input.now ?? DEFAULT_NOW);
  const attemptId = input.attemptId ?? "devops-self-host-001";
  const commands = [commandSucceeded(`hobo up ${PLATFORM_PATH} --seed`, "seed Yard started")];
  const events = [];
  const provider = createProviderForPhase(input.phase2Failure);
  const bootstrap = runHoboYardUp({
    attemptId,
    targetYard: TARGET_YARD,
    targetCamp: TARGET_CAMP,
    now,
    provider,
    identity: createFakeIdentity({ federated: true }),
    operatorCredential: {
      id: "operator-login-svid-001",
      subject: "spiffe://operator/devops",
      expiresAt: "2026-06-28T09:30:00.000Z",
    },
  });
  events.push(...bootstrap.allEvents);

  if (bootstrap.status !== "completed") {
    commands.push(commandFailed(`hobo up ${PLATFORM_PATH} --camp ${TARGET_CAMP}`, bootstrap.reason));
    return deepFreeze({
      status: "recoverable",
      commands,
      events,
      seed: {
        status: "recoverable",
        runtime: "@hobo/runtime-local",
        reason: bootstrap.reason,
      },
      selfHostedYard: null,
      restore: null,
      upgrade: null,
      seedLog: null,
      operatorLaptop: operatorLaptop(),
    });
  }

  commands.push(commandSucceeded(`hobo up ${PLATFORM_PATH} --camp ${TARGET_CAMP}`, "self-hosted Yard live"));
  const liveEvent = journeyEvent("yard.Live", events.length + 1, now, {
    targetYard: TARGET_YARD,
    targetCamp: TARGET_CAMP,
    controlPlaneHost: TARGET_CAMP,
    identityBroker: "real-yard-identity",
    activeSetRef: bootstrap.targetState.setRef ?? BASE_SET_REF,
    reachableUrl: "https://yard-prod.host-azure.hobo.local",
  });
  events.push(liveEvent);

  const seedLog = buildLastGoodLog(events, {
    uri: `eventlog://${TARGET_YARD}/last-good`,
    targetYard: TARGET_YARD,
    targetCamp: TARGET_CAMP,
  });
  commands.push(commandSucceeded(`hobo up ${PLATFORM_PATH} --restore ${seedLog.uri}`, "last-good control plane restored"));
  const restore = restoreSelfHostedYardFromLog(seedLog, { now, seqStart: events.length + 1 });
  events.push(...restore.events);

  const upgrade = runUpgrade({
    currentSetRef: bootstrap.targetState.setRef ?? BASE_SET_REF,
    gate: input.upgradeGate ?? { status: "passed" },
    now,
    seqStart: events.length + 1,
  });
  events.push(...upgrade.events);
  commands.push(
    upgrade.status === "applied"
      ? commandSucceeded(`hobo up ${PLATFORM_PATH}`, "upgrade applied")
      : commandFailed(`hobo up ${PLATFORM_PATH}`, upgrade.reason),
  );

  return deepFreeze({
    status: "self-hosted",
    commands,
    events,
    seed: {
      status: "retired",
      runtime: "@hobo/runtime-local",
      credentialRetired: true,
    },
    selfHostedYard: {
      reachable: true,
      reachableUrl: "https://yard-prod.host-azure.hobo.local",
      controlPlaneHost: TARGET_CAMP,
      identityBroker: "real-yard-identity",
      activeSetRef: upgrade.activeSetRef,
      lastGoodSetRef: restore.setRef,
    },
    restore: omitEvents(restore),
    upgrade: omitEvents(upgrade),
    seedLog,
    operatorLaptop: operatorLaptop(),
  });
}

export function attemptSeedCredentialReuse(journey) {
  const seedTokenUseCount = countEvents(journey?.events ?? [], "identity.SeedTokenUsed");
  const retired = journey?.seed?.credentialRetired === true || journey?.seed?.status === "retired";
  if (retired) {
    return deepFreeze({
      allowed: false,
      reason: "seed-credential-retired",
      audit: {
        seedTokenUseCount,
      },
      events: [
        journeyEvent("identity.SeedTokenReuseDenied", 1, DEFAULT_NOW, {
          reason: "seed-credential-retired",
          credentialId: "operator-login-svid-001",
        }),
      ],
    });
  }

  return deepFreeze({
    allowed: true,
    reason: null,
    audit: {
      seedTokenUseCount,
    },
    events: [
      journeyEvent("identity.SeedTokenUsed", 1, DEFAULT_NOW, {
        credentialId: "operator-login-svid-001",
        singleUse: false,
      }),
    ],
  });
}

export function restoreSelfHostedYardFromLog(log, options = {}) {
  const events = Array.isArray(log?.events) ? log.events : [];
  const missing = ["bootstrap.Completed", "yard.Live", "token.Revoked", "seed.Discarded"].filter(
    (type) => !events.some((event) => event.type === type),
  );
  if (missing.length > 0) {
    throw codedError("restore-log-incomplete", `restore-log-incomplete: missing ${missing.join(", ")}`);
  }
  if (log.liveCommandReplay === true) {
    throw codedError("restore-log-live-command-replay", "restore-log-live-command-replay");
  }

  const expectedHash = hashEvents(events);
  if (log.hash !== expectedHash) {
    throw codedError("restore-log-hash-mismatch", "restore-log-hash-mismatch");
  }

  const live = events.findLast((event) => event.type === "yard.Live");
  const restored = journeyEvent("yard.Restored", options.seqStart ?? 1, iso(options.now ?? DEFAULT_NOW), {
    targetYard: log.targetYard,
    targetCamp: log.targetCamp,
    setRef: live.data.activeSetRef,
    sourceLogHash: log.hash,
    stateOwner: "host-azure",
  });

  return deepFreeze({
    status: "restored",
    setRef: live.data.activeSetRef,
    targetYard: log.targetYard,
    targetCamp: log.targetCamp,
    sourceLogHash: log.hash,
    events: [restored],
  });
}

function runUpgrade({ currentSetRef, gate, now, seqStart }) {
  const normalizedGate = gate?.status === "failed" ? gate : { status: "passed" };
  if (normalizedGate.status === "failed") {
    return deepFreeze({
      status: "rolled-back",
      reason: normalizedGate.reason ?? "upgrade gate failed",
      gate: "hobo.up",
      activeSetRef: currentSetRef,
      events: [
        journeyEvent("yard.UpgradeRolledBack", seqStart, now, {
          gate: "hobo.up",
          previousSetRef: currentSetRef,
          reason: normalizedGate.reason ?? "upgrade gate failed",
        }),
      ],
    });
  }

  return deepFreeze({
    status: "applied",
    reason: null,
    gate: "hobo.up",
    activeSetRef: UPGRADE_SET_REF,
    events: [
      journeyEvent("yard.UpgradeApplied", seqStart, now, {
        gate: "hobo.up",
        previousSetRef: currentSetRef,
        nextSetRef: UPGRADE_SET_REF,
      }),
    ],
  });
}

function createProviderForPhase(phase2Failure) {
  if (phase2Failure === "operator-credential-expired-mid-apply") {
    return createFakeProvider({ expireCredentialDuringApply: true });
  }
  return createFakeProvider();
}

function buildLastGoodLog(events, { uri, targetYard, targetCamp }) {
  return deepFreeze({
    uri,
    targetYard,
    targetCamp,
    replayMode: "control-plane-restore",
    liveCommandReplay: false,
    hash: hashEvents(events),
    events: clone(events),
  });
}

function commandSucceeded(command, stdout) {
  return deepFreeze({
    command,
    exitCode: 0,
    stdout,
    stderr: "",
  });
}

function commandFailed(command, reason) {
  return deepFreeze({
    command,
    exitCode: 1,
    stdout: "",
    stderr: reason ?? "hobo up failed",
  });
}

function journeyEvent(type, seq, occurredAt, data) {
  return deepFreeze({
    id: `devops-self-host:${seq}:${type}`,
    seq,
    type,
    occurredAt,
    correlationId: "journey:devops-self-host-yard",
    schemaVersion: DEVOPS_SELF_HOST_YARD_JOURNEY_VERSION,
    data,
  });
}

function operatorLaptop() {
  return deepFreeze({
    role: "cli-client-only",
    storesControlPlaneState: false,
  });
}

function omitEvents(value) {
  const cloneValue = clone(value);
  delete cloneValue.events;
  return cloneValue;
}

function countEvents(events, type) {
  return events.filter((event) => event.type === type).length;
}

function hashEvents(events) {
  return createHash("sha256").update(JSON.stringify(sortKeys(events))).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function iso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ISO time: ${value}`);
  }
  return parsed.toISOString();
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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
