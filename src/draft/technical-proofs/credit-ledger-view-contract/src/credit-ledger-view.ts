import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const CREDIT_LEDGER_VIEW = "CreditLedgerView";

const CREDIT_EVENT_TYPES = new Set(["credit.Registered", "credit.Reset"]);
const USAGE_EVENT_TYPES = new Set(["meter.UsageRecorded", "spend.Recorded"]);

export function snapshotCreditLedger(events, options = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  const seq = requireNonNegativeInteger(options.seq, "options.seq");
  const asOf = normalizeInstant(options.clock ?? options.asOf, "options.clock");
  const accounts = new Map();
  const exhaustedCredits = new Set();

  for (const event of events.filter((candidate) => eventSeq(candidate) <= seq).sort(compareEvents)) {
    if (CREDIT_EVENT_TYPES.has(event.type)) {
      const account = ensureAccount(accounts, event);
      const creditId = requireString(event.creditId, "event.creditId");
      exhaustedCredits.delete(creditId);
      account.currency = requireString(event.currency, "event.currency");
      account.listUnitCost = requireFiniteNumber(event.listUnitCost, "event.listUnitCost");
      account.credits.push({
        creditId,
        sourceType: event.type,
        amount: requireFiniteNumber(event.amount, "event.amount"),
        currency: account.currency,
        listUnitCost: account.listUnitCost,
        windowStart: normalizeInstant(event.windowStart, "event.windowStart"),
        windowEnd: normalizeInstant(event.windowEnd, "event.windowEnd"),
        expiresAt: event.expiresAt ? normalizeInstant(event.expiresAt, "event.expiresAt") : null,
        seq: eventSeq(event),
      });
      continue;
    }

    if (USAGE_EVENT_TYPES.has(event.type)) {
      const account = ensureAccount(accounts, event);
      account.usages.push({
        sourceType: event.type,
        quantity: requireFiniteNumber(event.quantity, "event.quantity"),
        occurredAt: normalizeInstant(event.occurredAt, "event.occurredAt"),
        seq: eventSeq(event),
      });
      continue;
    }

    if (event.type === "credit.Exhausted") {
      exhaustedCredits.add(requireString(event.creditId, "event.creditId"));
    }
  }

  const accountSnapshots = [...accounts.values()]
    .map((account) => projectAccount(account, { asOf, exhaustedCredits }))
    .sort((left, right) => {
      const provider = left.providerId.localeCompare(right.providerId);
      return provider || left.dimension.localeCompare(right.dimension);
    });

  const snapshot = {
    view: CREDIT_LEDGER_VIEW,
    seq,
    asOf,
    casRequiredForReservation: true,
    accounts: accountSnapshots,
  };

  return {
    ...snapshot,
    digest: sha256(canonicalJson(snapshot)),
  };
}

export function quoteEffectiveMarginalCost(snapshot, request) {
  if (!snapshot || snapshot.view !== CREDIT_LEDGER_VIEW) {
    throw new TypeError("snapshot must be a CreditLedgerView snapshot");
  }

  const providerId = requireString(request?.providerId, "request.providerId");
  const dimension = requireString(request?.dimension, "request.dimension");
  const units = requireFiniteNumber(request?.units ?? 1, "request.units");
  if (units <= 0) {
    throw new RangeError("request.units must be greater than 0");
  }

  const account = snapshot.accounts.find(
    (candidate) => candidate.providerId === providerId && candidate.dimension === dimension,
  );
  if (!account) {
    throw new RangeError(`unknown ledger account ${providerId}/${dimension}`);
  }

  const segments = [];
  let remainingUnits = units;
  const freeUnits = Math.min(remainingUnits, account.freeHeadroom);
  if (freeUnits > 0) {
    segments.push({ units: roundQuantity(freeUnits), unitCost: 0, reason: "free-headroom" });
    remainingUnits = roundQuantity(remainingUnits - freeUnits);
  }

  if (remainingUnits > 0) {
    segments.push({
      units: roundQuantity(remainingUnits),
      unitCost: account.listUnitCost,
      reason: "list-price",
    });
  }

  const totalCost = roundCost(
    segments.reduce((total, segment) => total + segment.units * segment.unitCost, 0),
  );

  return {
    view: "CreditLedgerViewQuote",
    snapshotSeq: snapshot.seq,
    snapshotDigest: snapshot.digest,
    providerId,
    dimension,
    units,
    currency: account.currency,
    marginalUnitCost: account.freeHeadroom > 0 ? 0 : account.listUnitCost,
    effectiveUnitCost: roundCost(totalCost / units),
    totalCost,
    segments,
  };
}

function projectAccount(account, { asOf, exhaustedCredits }) {
  const asOfMs = Date.parse(asOf);
  const activeCredits = account.credits
    .filter((credit) => !exhaustedCredits.has(credit.creditId))
    .filter((credit) => isCreditActiveAt(credit, asOfMs))
    .sort(compareCreditsForDepletion);
  const remainingByCredit = new Map(
    activeCredits.map((credit) => [credit.creditId, { ...credit, consumed: 0, freeHeadroom: credit.amount }]),
  );

  for (const usage of account.usages.sort(compareUsages)) {
    if (Date.parse(usage.occurredAt) > asOfMs) {
      continue;
    }

    let remainingUsage = usage.quantity;
    for (const credit of activeCredits) {
      if (remainingUsage <= 0) {
        break;
      }
      if (!usageFallsInsideCreditWindow(usage, credit)) {
        continue;
      }

      const state = remainingByCredit.get(credit.creditId);
      const consumed = Math.min(remainingUsage, state.freeHeadroom);
      state.consumed = roundQuantity(state.consumed + consumed);
      state.freeHeadroom = roundQuantity(state.freeHeadroom - consumed);
      remainingUsage = roundQuantity(remainingUsage - consumed);
    }
  }

  const credits = [...remainingByCredit.values()].map((credit) => ({
    creditId: credit.creditId,
    sourceType: credit.sourceType,
    amount: credit.amount,
    consumed: credit.consumed,
    freeHeadroom: credit.freeHeadroom,
    windowStart: credit.windowStart,
    windowEnd: credit.windowEnd,
    expiresAt: credit.expiresAt,
    seq: credit.seq,
  }));

  return {
    providerId: account.providerId,
    dimension: account.dimension,
    currency: account.currency,
    listUnitCost: account.listUnitCost,
    freeAllotment: roundQuantity(credits.reduce((total, credit) => total + credit.amount, 0)),
    consumed: roundQuantity(credits.reduce((total, credit) => total + credit.consumed, 0)),
    freeHeadroom: roundQuantity(credits.reduce((total, credit) => total + credit.freeHeadroom, 0)),
    credits,
  };
}

function ensureAccount(accounts, event) {
  const providerId = requireString(event.providerId, "event.providerId");
  const dimension = requireString(event.dimension, "event.dimension");
  const key = `${providerId}\u0000${dimension}`;
  if (!accounts.has(key)) {
    accounts.set(key, {
      providerId,
      dimension,
      currency: event.currency ?? "USD",
      listUnitCost: Number.isFinite(event.listUnitCost) ? event.listUnitCost : 0,
      credits: [],
      usages: [],
    });
  }
  return accounts.get(key);
}

function compareEvents(left, right) {
  const seqDelta = eventSeq(left) - eventSeq(right);
  if (seqDelta !== 0) {
    return seqDelta;
  }
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function compareCreditsForDepletion(left, right) {
  const leftExpiry = Date.parse(left.expiresAt ?? left.windowEnd);
  const rightExpiry = Date.parse(right.expiresAt ?? right.windowEnd);
  return leftExpiry - rightExpiry || left.seq - right.seq || left.creditId.localeCompare(right.creditId);
}

function compareUsages(left, right) {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.seq - right.seq;
}

function eventSeq(event) {
  return requireNonNegativeInteger(event?.seq, "event.seq");
}

function isCreditActiveAt(credit, asOfMs) {
  const start = Date.parse(credit.windowStart);
  const end = Date.parse(credit.windowEnd);
  const expires = credit.expiresAt ? Date.parse(credit.expiresAt) : end;
  return asOfMs >= start && asOfMs < Math.min(end, expires);
}

function usageFallsInsideCreditWindow(usage, credit) {
  const occurredAt = Date.parse(usage.occurredAt);
  return occurredAt >= Date.parse(credit.windowStart) && occurredAt < Date.parse(credit.windowEnd);
}

function normalizeInstant(value, fieldName) {
  if (!isJsonString(value)) {
    throw new TypeError(`${fieldName} must be an ISO-8601 string`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return new Date(timestamp).toISOString();
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value, fieldName) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function roundCost(value) {
  return Number(value.toFixed(12));
}

function roundQuantity(value) {
  return Number(value.toFixed(9));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
