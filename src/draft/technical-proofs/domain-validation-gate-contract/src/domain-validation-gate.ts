import { isJsonString, isJsonObject } from "./json.js";
export const REQUIRED_CHECK_KINDS = Object.freeze([
  "multi-vantage-resolve",
  "ttl-aware-propagation",
  "acme-challenge",
  "endpoint-health",
]);

export function createDomainValidationGate({ checks, timeoutMs = 1_000, clock = defaultClock } = {}) {
  const normalizedChecks = normalizeChecks(checks);

  return Object.freeze({
    async validate(request) {
      const normalized = normalizeRequest(request);
      const events = [
        domainEvent("domain.ValidationStarted", {
          changeId: normalized.changeId,
          domain: normalized.domain,
          camp: normalized.camp,
          checks: [...REQUIRED_CHECK_KINDS],
          stage: "shadow",
          liveZoneMutationAllowed: false,
          ts: clock(),
        }),
      ];

      let shadowChange;
      try {
        shadowChange = await normalized.stage();
      } catch (error) {
        return failedResult(events, normalized, {
          failedCheck: "shadow-stage",
          reason: messageOf(error),
          clock,
        });
      }
      const stagingInvariant = liveZoneInvariantFailure(normalized, "shadow staging");
      if (stagingInvariant) {
        return failedResult(events, normalized, {
          failedCheck: "live-zone-invariant",
          reason: stagingInvariant,
          liveZoneUntouched: false,
          shadowChange,
          clock,
        });
      }

      const passedChecks = [];
      for (const kind of REQUIRED_CHECK_KINDS) {
        const result = await runCheck(kind, normalizedChecks[kind], normalized, timeoutMs);
        const checkInvariant = liveZoneInvariantFailure(normalized, kind);
        if (checkInvariant) {
          return failedResult(events, normalized, {
            failedCheck: "live-zone-invariant",
            reason: checkInvariant,
            liveZoneUntouched: false,
            passedChecks,
            shadowChange,
            clock,
          });
        }

        if (!result.ok) {
          return failedResult(events, normalized, {
            failedCheck: kind,
            reason: result.reason,
            passedChecks,
            shadowChange,
            clock,
          });
        }

        passedChecks.push({
          kind,
          status: "passed",
          evidence: result.evidence ?? {},
        });
      }

      events.push(
        domainEvent("domain.Validated", {
          changeId: normalized.changeId,
          domain: normalized.domain,
          camp: normalized.camp,
          stage: "shadow",
          liveZoneUntouched: true,
          shadowChangeEvent: shadowChange?.event?.type ?? null,
          checks: passedChecks,
          ts: clock(),
        }),
      );
      assertValidationEventSequence(events);

      return Object.freeze({
        status: "validated",
        events,
        checks: passedChecks,
      });
    },
  });
}

export function domainValidationChecks(fixtures) {
  const values = fixtures ?? {};
  return Object.freeze({
    "multi-vantage-resolve": () => {
      const fixture = values["multi-vantage-resolve"] ?? {};
      const vantagePoints = fixture.vantagePoints ?? [];
      if (!Array.isArray(vantagePoints) || new Set(vantagePoints).size < 2) {
        return fail("multi-vantage resolution requires at least two independent vantage points");
      }
      if (!fixture.expected) {
        return fail("multi-vantage resolution requires an expected target");
      }
      return pass({ vantagePoints: [...vantagePoints], expected: fixture.expected });
    },
    "ttl-aware-propagation": () => {
      const fixture = values["ttl-aware-propagation"] ?? {};
      const waitedSeconds = Number(fixture.waitedSeconds);
      const ttlSeconds = Number(fixture.ttlSeconds);
      if (!Number.isFinite(waitedSeconds) || !Number.isFinite(ttlSeconds)) {
        return fail("TTL propagation check requires waitedSeconds and ttlSeconds");
      }
      if (waitedSeconds < ttlSeconds) {
        return fail(`TTL propagation waited ${waitedSeconds}s, below TTL ${ttlSeconds}s`);
      }
      return pass({ waitedSeconds, ttlSeconds });
    },
    "acme-challenge": () => {
      const challengeName = values["acme-challenge"]?.challengeName;
      if (!isJsonString(challengeName) || !challengeName.startsWith("_acme-challenge.")) {
        return fail("ACME challenge must be bound to the domain DNS-01 challenge name");
      }
      return pass({ challengeName });
    },
    "endpoint-health": () => {
      const fixture = values["endpoint-health"] ?? {};
      const status = Number(fixture.status);
      if (!Number.isInteger(status) || status < 200 || status >= 400) {
        return fail("endpoint health check must return a 2xx/3xx status");
      }
      return pass({ healthPath: fixture.healthPath ?? "/healthz", status });
    },
  });
}

export function createLiveZoneSnapshot(adapter, domain) {
  const before = stableZoneSnapshot(adapter, domain);
  return Object.freeze({
    assertUnchanged(label) {
      const after = stableZoneSnapshot(adapter, domain);
      if (after !== before) {
        throw new Error(`live zone changed during ${label}`);
      }
    },
  });
}

export function assertValidationEventSequence(events) {
  if (!Array.isArray(events) || events.length < 2) {
    throw new Error("validation event sequence requires started plus terminal event");
  }
  if (events[0]?.type !== "domain.ValidationStarted") {
    throw new Error("validation event sequence must start with domain.ValidationStarted");
  }

  const terminal = events.at(-1);
  if (terminal.type === "domain.Validated") {
    const passed = new Map((terminal.data?.checks ?? []).map((check) => [check.kind, check.status]));
    for (const kind of REQUIRED_CHECK_KINDS) {
      if (passed.get(kind) !== "passed") {
        throw new Error(`missing passed check: ${kind}`);
      }
    }
    if (terminal.data.liveZoneUntouched !== true) {
      throw new Error("domain.Validated must prove the live zone stayed untouched");
    }
    return true;
  }

  if (terminal.type === "domain.ValidationFailed") {
    if (!isJsonString(terminal.data?.failedCheck) || terminal.data.failedCheck.length === 0) {
      throw new Error("domain.ValidationFailed must name failedCheck");
    }
    return true;
  }

  throw new Error(`unknown validation terminal event: ${terminal.type}`);
}

function liveZoneInvariantFailure(request, label) {
  try {
    request.liveZone?.assertUnchanged(label);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

async function runCheck(kind, check, request, timeoutMs) {
  try {
    const result = await withTimeout(Promise.resolve().then(() => check(request)), timeoutMs, kind);
    if (result?.ok === true) {
      return pass(result.evidence ?? {});
    }
    if (result?.ok === false) {
      return fail(result.reason ?? `${kind} failed`);
    }
    return fail(`${kind} unfinished`);
  } catch (error) {
    return fail(messageOf(error));
  }
}

function withTimeout(promise, timeoutMs, kind) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${kind} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function failedResult(
  events,
  request,
  { failedCheck, reason, passedChecks = [], shadowChange, liveZoneUntouched = true, clock },
) {
  events.push(
    domainEvent("domain.ValidationFailed", {
      changeId: request.changeId,
      domain: request.domain,
      camp: request.camp,
      failedCheck,
      reason,
      stage: "shadow",
      liveZoneUntouched,
      shadowChangeEvent: shadowChange?.event?.type ?? null,
      checks: passedChecks,
      ts: clock(),
    }),
  );
  assertValidationEventSequence(events);

  return Object.freeze({
    status: "failed",
    failedCheck,
    reason,
    events,
    checks: passedChecks,
  });
}

function normalizeChecks(checks) {
  if (!checks || !isJsonObject(checks)) {
    throw new Error("domain validation gate requires checks");
  }

  const normalized = {};
  for (const kind of REQUIRED_CHECK_KINDS) {
    if (!(checks[kind] instanceof Function)) {
      throw new Error(`missing validation check: ${kind}`);
    }
    normalized[kind] = checks[kind];
  }
  return normalized;
}

function normalizeRequest(request) {
  if (!request || !isJsonObject(request)) {
    throw new Error("validation request is required");
  }
  const domain = requireString(request.domain, "domain");
  const changeId = requireString(request.changeId, "changeId");
  const camp = requireString(request.camp, "camp");
  if (!(request.stage instanceof Function)) {
    throw new Error("validation request requires a shadow stage function");
  }
  return {
    domain,
    changeId,
    camp,
    stage: request.stage,
    liveZone: request.liveZone,
  };
}

function domainEvent(type, data) {
  return Object.freeze({
    type,
    data: Object.freeze(data),
  });
}

function stableZoneSnapshot(adapter, domain) {
  const records = adapter
    .inspectLiveZone(domain)
    .map((record) => JSON.parse(JSON.stringify(record)))
    .sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
  return JSON.stringify(records);
}

function pass(evidence) {
  return Object.freeze({ ok: true, evidence });
}

function fail(reason) {
  return Object.freeze({ ok: false, reason });
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultClock() {
  return new Date(0).toISOString();
}
