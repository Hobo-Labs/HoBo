import { createHash } from "node:crypto";

import {
  createDispatchDecidedEvent,
  createMatchDecidedEvent,
} from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { isJsonString, isJsonObject } from "./json.js";


export const DISPATCHER_MAXIMIZE_CREDITS_VERSION = "hobo.dispatcher-maximize-credits/v1";

const OBJECTIVES = new Set(["maximize-credits"]);
const DISPATCH_CATEGORIES = new Set(["runner", "build-machine"]);
const CATEGORY_DIMENSIONS = Object.freeze({
  runner: "runner.minutes",
  "build-machine": "build.minutes",
});
const LARGE_SCORE = Number.MAX_SAFE_INTEGER;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;

export function createDispatcherRegistry(providers = []) {
  if (!Array.isArray(providers)) {
    throw new TypeError("providers must be an array");
  }

  const records = providers.map(normalizeDispatchProvider);
  const byCategory = new Map();
  for (const record of records) {
    if (!record.registered) continue;
    const bucket = byCategory.get(record.category) ?? [];
    bucket.push(record);
    byCategory.set(record.category, bucket);
  }

  return {
    schema: `${DISPATCHER_MAXIMIZE_CREDITS_VERSION}.registry`,
    records,
    byCategory,
  };
}

export function decideDispatch(request) {
  assertObject(request, "request");
  const category = requireCategory(request.category);
  const objective = requireObjective(request.objective ?? "maximize-credits");
  const dispatchId = requireString(request.dispatchId, "request.dispatchId");
  const units = requirePositiveNumber(request.units ?? 1, "request.units");
  const registry = normalizeRegistry(request.registry);
  const candidates = registry.byCategory.get(category) ?? [];
  const ledgerView = normalizeLedgerView(request.ledgerView);
  const hysteresisInput = normalizeHysteresis(request.hysteresis);
  const incumbentProviderId = request.incumbentProviderId ?? hysteresisInput?.incumbentProviderId;
  const reservationId = requireString(
    request.reservationId ?? `reservation-intent-${dispatchId}`,
    "request.reservationId",
  );

  if (candidates.length === 0) {
    return failedDecision({
      objective,
      reason: `no registered ${category} candidates`,
    });
  }

  const ranked = rankCreditCandidates({
    candidates,
    ledgerView,
    units,
    incumbentProviderId,
  });
  const hysteresis = applyHysteresis(ranked, hysteresisInput);
  const finalRanked = hysteresis.ranked;
  const winner = finalRanked[0];
  const dispatchEvent = createDispatchDecidedEvent({
    dispatchId,
    category,
    selectedProvider: winner.providerId,
    objective,
    ledgerInput: {
      view: "CreditLedgerView",
      seq: ledgerView.seq,
      reservationId,
      balanceHash: ledgerBalanceHash(ledgerView),
    },
    candidates: finalRanked.map((candidate) => ({
      provider: candidate.providerId,
      effectiveMarginalCost: candidate.effectiveMarginalCost,
      rationale: candidate.rationale,
    })),
  });

  return {
    ok: true,
    schema: DISPATCHER_MAXIMIZE_CREDITS_VERSION,
    objective,
    selectedProvider: winner.providerId,
    ranking: publicDispatchRanking(finalRanked),
    hysteresis: hysteresis.public,
    dispatchEvent,
    replayInput: {
      category,
      dispatchId,
      objective,
      units,
      incumbentProviderId,
      hysteresis: hysteresisInput,
      reservationId,
      ledgerView: clone(ledgerView),
      candidates: registry.records.map((record) => clone(record.source)),
    },
  };
}

export function createReservationLedger(initialLedgerView) {
  let current = normalizeLedgerView(initialLedgerView);
  const eventLog = [];

  return {
    snapshot() {
      return clone(current);
    },
    events() {
      return clone(eventLog);
    },
    reserve(request) {
      assertObject(request, "request");
      const providerId = requireString(request.providerId, "request.providerId");
      const dimension = requireString(request.dimension, "request.dimension");
      const reservationId = requireString(request.reservationId, "request.reservationId");
      const units = requirePositiveNumber(request.units ?? 1, "request.units");
      const expectedSeq = requireNonNegativeInteger(request.expectedSeq, "request.expectedSeq");
      const expiresAt = optionalInstant(request.expiresAt, "request.expiresAt");

      if (expectedSeq !== current.seq) {
        return {
          ok: false,
          status: "cas-conflict",
          reservationId,
          providerId,
          dimension,
          expectedSeq,
          actualSeq: current.seq,
          ledgerView: clone(current),
        };
      }

      const next = clone(current);
      const account = findLedgerAccount(next, providerId, dimension);
      let consumption = { freeHeadroom: 0, credits: [] };
      if (account) {
        consumption = consumeReservedFreeHeadroom(account, units);
        account.reservedUnits = roundQuantity((account.reservedUnits ?? 0) + units);
      }
      const committedSeq = next.seq + 1;
      const reservation = {
        reservationId,
        providerId,
        dimension,
        units,
        expectedSeq,
        committedSeq,
        status: "pending",
        expiresAt,
        consumption,
      };
      next.seq = committedSeq;
      next.reservations = [
        ...(Array.isArray(next.reservations) ? next.reservations : []),
        reservation,
      ];
      current = next;
      eventLog.push(reservationEvent("dispatch.ReservationReserved", reservation, {
        ledgerSeq: current.seq,
      }));

      return {
        ok: true,
        status: "reserved",
        reservationId,
        providerId,
        dimension,
        units,
        expectedSeq,
        committedSeq,
        reservation: clone(reservation),
        ledgerView: clone(current),
      };
    },
    confirm(request) {
      assertObject(request, "request");
      const reservationId = requireString(request.reservationId, "request.reservationId");
      const next = clone(current);
      const reservation = findReservation(next, reservationId);
      if (!reservation || reservation.status !== "pending") {
        return {
          ok: false,
          status: "not-confirmable",
          reservationId,
          ledgerView: clone(current),
        };
      }

      const committedSeq = next.seq + 1;
      reservation.status = "confirmed";
      reservation.confirmedSeq = committedSeq;
      if (request.providerUsageSeq !== undefined) {
        reservation.providerUsageSeq = requireNonNegativeInteger(
          request.providerUsageSeq,
          "request.providerUsageSeq",
        );
      }
      next.seq = committedSeq;
      current = next;
      eventLog.push(reservationEvent("dispatch.ReservationConfirmed", reservation, {
        ledgerSeq: current.seq,
        providerUsageSeq: reservation.providerUsageSeq,
      }));

      return {
        ok: true,
        status: "confirmed",
        reservationId,
        committedSeq,
        reservation: clone(reservation),
        ledgerView: clone(current),
      };
    },
    release(request) {
      assertObject(request, "request");
      const reservationId = requireString(request.reservationId, "request.reservationId");
      const reason = requireString(request.reason ?? "released", "request.reason");
      return releaseReservation({
        reservationId,
        reason,
        eventType: "dispatch.ReservationReleased",
      });
    },
    expire(request) {
      assertObject(request, "request");
      const now = requireInstant(request.now, "request.now");
      const expiredIds = (current.reservations ?? [])
        .filter((reservation) => reservation.status === "pending")
        .filter((reservation) => reservation.expiresAt && Date.parse(reservation.expiresAt) <= Date.parse(now))
        .map((reservation) => reservation.reservationId);
      const releases = expiredIds.map((reservationId) => releaseReservation({
        reservationId,
        reason: "expired",
        eventType: "dispatch.ReservationExpired",
      }));

      return {
        released: releases.filter((release) => release.ok).length,
        releases,
        ledgerView: clone(current),
      };
    },
  };

  function releaseReservation({ reservationId, reason, eventType }) {
    const next = clone(current);
    const reservation = findReservation(next, reservationId);
    if (!reservation || reservation.status !== "pending") {
      return {
        ok: false,
        status: "not-releasable",
        reservationId,
        ledgerView: clone(current),
      };
    }

    const account = findLedgerAccount(next, reservation.providerId, reservation.dimension);
    if (account) {
      restoreReservedFreeHeadroom(account, reservation.consumption);
      account.reservedUnits = roundQuantity(Math.max(0, (account.reservedUnits ?? 0) - reservation.units));
    }
    const committedSeq = next.seq + 1;
    reservation.status = eventType === "dispatch.ReservationExpired" ? "expired" : "released";
    reservation.releaseReason = reason;
    reservation.releasedSeq = committedSeq;
    next.seq = committedSeq;
    current = next;
    eventLog.push(reservationEvent(eventType, reservation, {
      ledgerSeq: current.seq,
      reason,
    }));

    return {
      ok: true,
      status: reservation.status,
      reservationId,
      committedSeq,
      reservation: clone(reservation),
      ledgerView: clone(current),
    };
  }
}

export function decideAndReserveDispatch(request) {
  assertObject(request, "request");
  const reservationLedger = request.reservationLedger;
  if (
    !reservationLedger ||
    !(reservationLedger.snapshot instanceof Function) ||
    !(reservationLedger.reserve instanceof Function)
  ) {
    throw new TypeError("request.reservationLedger must be a reservation ledger");
  }

  const maxAttempts = requirePositiveInteger(request.maxAttempts ?? 3, "request.maxAttempts");
  const registry = normalizeRegistry(request.registry);
  let ledgerView = request.ledgerView ? normalizeLedgerView(request.ledgerView) : reservationLedger.snapshot();
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const decision = decideDispatch({
      ...request,
      registry,
      ledgerView,
      reservationId: request.reservationId ?? `reserve-${request.dispatchId}`,
    });
    if (!decision.ok) {
      return {
        ...decision,
        attempts,
      };
    }

    const selectedRecord = registry.records.find((record) => record.providerId === decision.selectedProvider);
    const dimension = selectedRecord?.dimension ?? CATEGORY_DIMENSIONS[decision.dispatchEvent.data.category];
    const reservation = reservationLedger.reserve({
      providerId: decision.selectedProvider,
      dimension,
      units: request.units ?? 1,
      expectedSeq: ledgerView.seq,
      reservationId: decision.dispatchEvent.data.ledgerInput.reservationId,
      expiresAt: request.reservationExpiresAt,
    });
    attempts.push({
      attempt,
      status: reservation.status,
      selectedProvider: decision.selectedProvider,
      expectedSeq: ledgerView.seq,
      actualSeq: reservation.actualSeq ?? reservation.committedSeq,
    });

    if (reservation.ok) {
      return {
        ...decision,
        reservation,
        attempts,
      };
    }

    ledgerView = reservation.ledgerView;
  }

  return {
    ok: false,
    schema: DISPATCHER_MAXIMIZE_CREDITS_VERSION,
    objective: request.objective ?? "maximize-credits",
    reason: `reservation CAS failed after ${maxAttempts} attempts`,
    ranking: [],
    attempts,
  };
}

export function replayDispatchDecision(replayInput) {
  assertObject(replayInput, "replayInput");
  return decideDispatch({
    ...clone(replayInput),
    registry: createDispatcherRegistry(replayInput.candidates ?? []),
  });
}

export function decidePlacement(request) {
  assertObject(request, "request");
  const objective = requireObjective(request.objective ?? "maximize-credits");
  const resourceId = requireString(request.resourceId, "request.resourceId");
  const resourceType = requireString(request.resourceType, "request.resourceType");
  const units = requirePositiveNumber(request.units ?? 1, "request.units");
  const ledgerView = normalizeLedgerView(request.ledgerView);
  const rejectedCandidates = [];
  const candidates = [];

  for (const candidate of request.candidates ?? []) {
    const normalized = normalizePlacementCandidate(candidate);
    if (!normalized.registered) {
      rejectedCandidates.push({
        definitionId: normalized.definitionId,
        reason: "candidate is not registered",
      });
      continue;
    }
    if (normalized.resourceType !== resourceType) {
      rejectedCandidates.push({
        definitionId: normalized.definitionId,
        reason: `resourceType ${normalized.resourceType} does not match ${resourceType}`,
      });
      continue;
    }
    candidates.push(normalized);
  }

  if (candidates.length === 0) {
    return failedDecision({
      objective,
      reason: `no registered ${resourceType} placement candidates`,
      rejectedCandidates,
    });
  }

  const ranked = rankCreditCandidates({
    candidates,
    ledgerView,
    units,
    incumbentProviderId: request.incumbentProviderId,
  });
  const winner = ranked[0];
  const tiedDefinitionIds = ranked
    .filter((candidate) => compareDecisionVector(candidate, winner) === 0)
    .map((candidate) => candidate.definitionId);
  const ranking = publicPlacementRanking(ranked);
  const matchEvent = createMatchDecidedEvent({
    resourceId,
    winner: winner.definitionId,
    ranking,
    rejectedCandidates,
    objective,
    tie: tiedDefinitionIds.length > 1,
    catalogContentHash: normalizeHashRef(
      request.catalogContentHash ?? stableHash({ resourceType, candidates: candidates.map((candidate) => candidate.source) }),
    ),
  });

  return {
    ok: true,
    schema: DISPATCHER_MAXIMIZE_CREDITS_VERSION,
    objective,
    winner: winner.definitionId,
    selectedProvider: winner.providerId,
    ranking,
    rejectedCandidates,
    tiedDefinitionIds,
    matchEvent,
  };
}

function rankCreditCandidates({ candidates, ledgerView, units, incumbentProviderId }) {
  return candidates
    .map((candidate) => rankCreditCandidate({ candidate, ledgerView, units, incumbentProviderId }))
    .sort(compareRankedCandidates)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
}

function applyHysteresis(ranked, hysteresis) {
  if (!hysteresis) {
    return {
      ranked,
      public: {
        held: false,
        input: null,
      },
    };
  }

  const rawWinner = ranked[0];
  const incumbent = ranked.find((candidate) => candidate.providerId === hysteresis.incumbentProviderId);
  if (!rawWinner || !incumbent || rawWinner.providerId === incumbent.providerId) {
    return {
      ranked,
      public: {
        held: false,
        input: hysteresis,
        rawWinner: rawWinner?.providerId ?? null,
        incumbentProviderId: hysteresis.incumbentProviderId,
      },
    };
  }
  if (incumbent.budgetExceeded) {
    return {
      ranked,
      public: {
        held: false,
        input: hysteresis,
        rawWinner: rawWinner.providerId,
        incumbentProviderId: incumbent.providerId,
        reason: "incumbent-budget-exceeded",
      },
    };
  }

  const savings = roundCost(incumbent.totalCost - rawWinner.totalCost);
  if (savings >= hysteresis.minimumSavings) {
    return {
      ranked,
      public: {
        held: false,
        input: hysteresis,
        rawWinner: rawWinner.providerId,
        incumbentProviderId: incumbent.providerId,
        savings,
      },
    };
  }

  const heldIncumbent = {
    ...incumbent,
    rationale: [
      incumbent.rationale,
      `hysteresis-held rawWinner=${rawWinner.providerId}`,
      `savings=${savings}`,
      `minimumSavings=${hysteresis.minimumSavings}`,
      `dwellWindow=${hysteresis.dwellWindow}`,
      `observedAt=${hysteresis.observedAt}`,
    ].join("; "),
  };
  const heldChallenger = {
    ...rawWinner,
    rationale: [
      rawWinner.rationale,
      `hysteresis-challenger-held incumbent=${incumbent.providerId}`,
      `savings=${savings}`,
      `minimumSavings=${hysteresis.minimumSavings}`,
    ].join("; "),
  };
  const byProvider = new Map([
    [heldIncumbent.providerId, heldIncumbent],
    [heldChallenger.providerId, heldChallenger],
  ]);
  const reranked = [
    heldIncumbent,
    ...ranked.filter((candidate) => candidate.providerId !== incumbent.providerId).map((candidate) => (
      byProvider.get(candidate.providerId) ?? candidate
    )),
  ].map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));

  return {
    ranked: reranked,
    public: {
      held: true,
      input: hysteresis,
      rawWinner: rawWinner.providerId,
      incumbentProviderId: incumbent.providerId,
      savings,
      reason: "savings-below-threshold",
    },
  };
}

function rankCreditCandidate({ candidate, ledgerView, units, incumbentProviderId }) {
  const account = findLedgerAccount(ledgerView, candidate.providerId, candidate.dimension);
  const credit = creditFactsFor(account, candidate);
  const listUnitCost = credit.listUnitCost;
  const freeUnits = credit.valid
    ? Math.min(units, credit.freeHeadroom, credit.rateHeadroom, credit.concurrencyHeadroom > 0 ? LARGE_SCORE : 0)
    : 0;
  const paidUnits = Math.max(0, units - freeUnits);
  const switchingCost = incumbentProviderId && candidate.providerId !== incumbentProviderId
    ? nonNegativeNumber(candidate.switchingCost, "candidate.switchingCost", 0)
    : 0;
  const baseCost = roundCost(paidUnits * listUnitCost);
  const totalCost = roundCost(baseCost + switchingCost);
  const budgetExceeded = totalCost > credit.budgetHeadroom;
  const effectiveMarginalCost = roundCost(totalCost / units);
  const freeButNotDepletable = credit.valid && credit.freeHeadroom > 0 && freeUnits === 0;
  const nextCreditExpiresAt = credit.valid ? nextCreditExpiry(account) : null;
  const concurrencyScore = Number.isFinite(credit.concurrencyHeadroom)
    ? credit.concurrencyHeadroom
    : LARGE_SCORE;
  const expiryScore = freeUnits > 0 && nextCreditExpiresAt ? Date.parse(nextCreditExpiresAt) : LARGE_SCORE;
  const rationale = rationaleFor({
    credit,
    ledgerView,
    freeUnits,
    paidUnits,
    switchingCost,
    freeButNotDepletable,
  });

  return {
    ...candidate,
    totalCost,
    baseCost,
    listUnitCost,
    effectiveMarginalCost,
    freeUnits: roundQuantity(freeUnits),
    paidUnits: roundQuantity(paidUnits),
    switchingCost,
    budgetExceeded,
    creditFacts: credit.status,
    nextCreditExpiresAt,
    objectiveScore: effectiveMarginalCost,
    rationale,
    decisionVector: [
      budgetExceeded ? 1 : 0,
      effectiveMarginalCost,
      expiryScore,
      -concurrencyScore,
      listUnitCost,
      switchingCost,
    ],
    rankVector: [
      budgetExceeded ? 1 : 0,
      effectiveMarginalCost,
      expiryScore,
      -concurrencyScore,
      listUnitCost,
      switchingCost,
      candidate.providerId,
      candidate.definitionId ?? candidate.providerId,
    ],
  };
}

function creditFactsFor(account, candidate) {
  if (!account) {
    return {
      status: "missing",
      valid: false,
      listUnitCost: nonNegativeNumber(candidate.listUnitCost, "candidate.listUnitCost", LARGE_SCORE),
      freeHeadroom: 0,
      rateHeadroom: 0,
      concurrencyHeadroom: 0,
      budgetHeadroom: LARGE_SCORE,
    };
  }

  const listUnitCost = optionalNonNegativeNumber(account.listUnitCost)
    ? account.listUnitCost
    : nonNegativeNumber(candidate.listUnitCost, "candidate.listUnitCost", LARGE_SCORE);
  const freeHeadroom = freeHeadroomFor(account);
  const rateHeadroom = account.rateHeadroom === undefined ? LARGE_SCORE : account.rateHeadroom;
  const concurrencyHeadroom = account.concurrencyHeadroom === undefined ? LARGE_SCORE : account.concurrencyHeadroom;
  const budgetHeadroom = budgetHeadroomFor(account);
  const valid = [listUnitCost, freeHeadroom, rateHeadroom, concurrencyHeadroom, budgetHeadroom].every(optionalNonNegativeNumber);

  if (!valid) {
    return {
      status: "invalid",
      valid: false,
      listUnitCost: nonNegativeNumber(candidate.listUnitCost, "candidate.listUnitCost", LARGE_SCORE),
      freeHeadroom: 0,
      rateHeadroom: 0,
      concurrencyHeadroom: 0,
      budgetHeadroom: LARGE_SCORE,
    };
  }

  return {
    status: freeHeadroom > 0 ? "present" : "present-empty",
    valid: true,
    listUnitCost,
    freeHeadroom,
    rateHeadroom,
    concurrencyHeadroom,
    budgetHeadroom,
  };
}

function freeHeadroomFor(account) {
  if (account.freeHeadroom !== undefined) return account.freeHeadroom;
  if (!Array.isArray(account.credits)) return 0;
  return account.credits.reduce((total, credit) => {
    if (!optionalNonNegativeNumber(credit?.freeHeadroom)) return Number.NaN;
    return total + credit.freeHeadroom;
  }, 0);
}

function nextCreditExpiry(account) {
  const expiries = (account?.credits ?? [])
    .filter((credit) => optionalNonNegativeNumber(credit?.freeHeadroom) && credit.freeHeadroom > 0)
    .map((credit) => credit.expiresAt ?? credit.windowEnd)
    .filter((value) => isJsonString(value) && !Number.isNaN(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right) || left.localeCompare(right));
  return expiries[0] ?? null;
}

function budgetHeadroomFor(account) {
  if (account.budgetCap === undefined && account.spendToDate === undefined) return LARGE_SCORE;
  const budgetCap = account.budgetCap === undefined ? LARGE_SCORE : account.budgetCap;
  const spendToDate = account.spendToDate === undefined ? 0 : account.spendToDate;
  if (!optionalNonNegativeNumber(budgetCap) || !optionalNonNegativeNumber(spendToDate)) {
    return Number.NaN;
  }
  return Math.max(0, budgetCap - spendToDate);
}


function compareRankedCandidates(left, right) {
  for (let index = 0; index < Math.max(left.rankVector.length, right.rankVector.length); index += 1) {
    const leftValue = left.rankVector[index];
    const rightValue = right.rankVector[index];
    if (isJsonString(leftValue) || isJsonString(rightValue)) {
      const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
      if (comparison !== 0) return comparison;
      continue;
    }
    if ((leftValue ?? LARGE_SCORE) < (rightValue ?? LARGE_SCORE)) return -1;
    if ((leftValue ?? LARGE_SCORE) > (rightValue ?? LARGE_SCORE)) return 1;
  }
  return 0;
}

function compareDecisionVector(left, right) {
  for (let index = 0; index < Math.max(left.decisionVector.length, right.decisionVector.length); index += 1) {
    const leftValue = left.decisionVector[index] ?? LARGE_SCORE;
    const rightValue = right.decisionVector[index] ?? LARGE_SCORE;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function publicDispatchRanking(ranked) {
  return ranked.map((candidate) => ({
    providerId: candidate.providerId,
    category: candidate.category,
    dimension: candidate.dimension,
    rank: candidate.rank,
    effectiveMarginalCost: candidate.effectiveMarginalCost,
    totalCost: candidate.totalCost,
    freeUnits: candidate.freeUnits,
    paidUnits: candidate.paidUnits,
    switchingCost: candidate.switchingCost,
    budgetExceeded: candidate.budgetExceeded,
    creditFacts: candidate.creditFacts,
    nextCreditExpiresAt: candidate.nextCreditExpiresAt,
    rationale: candidate.rationale,
  }));
}

function publicPlacementRanking(ranked) {
  return ranked.map((candidate) => ({
    definitionId: candidate.definitionId,
    region: candidate.region,
    specificity: candidate.specificity,
    priority: candidate.priority,
    objectiveScore: candidate.objectiveScore,
    rank: candidate.rank,
    rationale: candidate.rationale,
  }));
}

function rationaleFor({ credit, ledgerView, freeUnits, paidUnits, switchingCost, freeButNotDepletable }) {
  const parts = [
    "objective=maximize-credits",
    `ledgerSeq=${ledgerView.seq}`,
    `credit-facts=${credit.status}`,
    `freeUnits=${roundQuantity(freeUnits)}`,
    `paidUnits=${roundQuantity(paidUnits)}`,
    `switchingCost=${switchingCost}`,
  ];
  if (freeButNotDepletable) {
    parts.push("free-tier-not-depletable");
  }
  if (credit.budgetHeadroom < LARGE_SCORE && paidUnits > 0 && paidUnits * credit.listUnitCost + switchingCost > credit.budgetHeadroom) {
    parts.push("budget-cap-exceeded");
  }
  return parts.join("; ");
}

function findLedgerAccount(ledgerView, providerId, dimension) {
  return (ledgerView.accounts ?? []).find(
    (account) => account?.providerId === providerId && account?.dimension === dimension,
  ) ?? null;
}

function normalizeDispatchProvider(provider) {
  assertObject(provider, "provider");
  const category = requireCategory(provider.category);
  const id = requireString(provider.id ?? provider.providerId, "provider.id");
  const providerId = requireString(provider.providerId ?? id, "provider.providerId");
  return {
    id,
    providerId,
    definitionId: id,
    category,
    registered: provider.registered !== false,
    dimension: provider.dimension ?? CATEGORY_DIMENSIONS[category],
    listUnitCost: nonNegativeNumber(provider.listUnitCost, "provider.listUnitCost", 0),
    switchingCost: nonNegativeNumber(provider.switchingCost ?? 0, "provider.switchingCost", 0),
    source: clone(provider),
  };
}

function normalizePlacementCandidate(candidate) {
  assertObject(candidate, "candidate");
  const definitionId = requireString(candidate.definitionId ?? candidate.id, "candidate.definitionId");
  const providerId = requireString(candidate.providerId ?? definitionId, "candidate.providerId");
  return {
    definitionId,
    providerId,
    category: "placement",
    registered: candidate.registered !== false,
    resourceType: requireString(candidate.resourceType, "candidate.resourceType"),
    dimension: requireString(candidate.dimension, "candidate.dimension"),
    listUnitCost: nonNegativeNumber(candidate.listUnitCost, "candidate.listUnitCost", 0),
    specificity: Number.isFinite(candidate.specificity) ? candidate.specificity : 0,
    priority: Number.isInteger(candidate.priority) ? candidate.priority : 0,
    region: isJsonString(candidate.region) && candidate.region.length > 0 ? candidate.region : undefined,
    switchingCost: nonNegativeNumber(candidate.switchingCost ?? 0, "candidate.switchingCost", 0),
    source: clone(candidate),
  };
}

function normalizeRegistry(registry) {
  if (Array.isArray(registry)) {
    return createDispatcherRegistry(registry);
  }
  if (!registry || !(registry.byCategory instanceof Map) || !Array.isArray(registry.records)) {
    throw new TypeError("request.registry must be a Dispatcher registry");
  }
  return registry;
}

function normalizeLedgerView(ledgerView) {
  if (!ledgerView || !isJsonObject(ledgerView) || Array.isArray(ledgerView)) {
    throw new TypeError("request.ledgerView must be a CreditLedgerView snapshot");
  }
  if (ledgerView.view !== "CreditLedgerView") {
    throw new TypeError("request.ledgerView.view must be CreditLedgerView");
  }
  if (!Number.isInteger(ledgerView.seq) || ledgerView.seq < 0) {
    throw new TypeError("request.ledgerView.seq must be a non-negative integer");
  }
  if (!Array.isArray(ledgerView.accounts)) {
    throw new TypeError("request.ledgerView.accounts must be an array");
  }
  return clone(ledgerView);
}

function normalizeHysteresis(hysteresis) {
  if (hysteresis === undefined || hysteresis === null) return null;
  assertObject(hysteresis, "request.hysteresis");
  return {
    incumbentProviderId: requireString(hysteresis.incumbentProviderId, "request.hysteresis.incumbentProviderId"),
    minimumSavings: nonNegativeNumber(hysteresis.minimumSavings ?? 0, "request.hysteresis.minimumSavings", 0),
    dwellWindow: requireString(hysteresis.dwellWindow, "request.hysteresis.dwellWindow"),
    observedAt: requireString(hysteresis.observedAt, "request.hysteresis.observedAt"),
  };
}

function findReservation(ledgerView, reservationId) {
  return (ledgerView.reservations ?? []).find((reservation) => reservation?.reservationId === reservationId) ?? null;
}

function reservationEvent(type, reservation, overrides = {}) {
  return {
    type,
    reservationId: reservation.reservationId,
    providerId: reservation.providerId,
    dimension: reservation.dimension,
    units: reservation.units,
    status: reservation.status,
    ledgerSeq: overrides.ledgerSeq,
    expectedSeq: reservation.expectedSeq,
    committedSeq: reservation.committedSeq,
    reason: overrides.reason,
    providerUsageSeq: overrides.providerUsageSeq,
  };
}

function consumeReservedFreeHeadroom(account, units) {
  let remaining = units;
  const consumption = {
    freeHeadroom: 0,
    credits: [],
  };
  if (optionalNonNegativeNumber(account.freeHeadroom)) {
    const consumed = Math.min(account.freeHeadroom, remaining);
    account.freeHeadroom = roundQuantity(account.freeHeadroom - consumed);
    consumption.freeHeadroom = roundQuantity(consumption.freeHeadroom + consumed);
    remaining = roundQuantity(remaining - consumed);
  }
  if (!Array.isArray(account.credits) || remaining <= 0) return consumption;
  for (const credit of account.credits) {
    if (!optionalNonNegativeNumber(credit?.freeHeadroom)) continue;
    const consumed = Math.min(credit.freeHeadroom, remaining);
    credit.freeHeadroom = roundQuantity(credit.freeHeadroom - consumed);
    if (consumed > 0) {
      consumption.credits.push({
        creditId: credit.creditId,
        units: roundQuantity(consumed),
      });
    }
    remaining = roundQuantity(remaining - consumed);
    if (remaining <= 0) return consumption;
  }
  return consumption;
}

function restoreReservedFreeHeadroom(account, consumption) {
  if (!consumption || !isJsonObject(consumption)) return;
  if (optionalNonNegativeNumber(account.freeHeadroom)) {
    account.freeHeadroom = roundQuantity(account.freeHeadroom + (consumption.freeHeadroom ?? 0));
  }
  if (!Array.isArray(account.credits) || !Array.isArray(consumption.credits)) return;
  for (const restoredCredit of consumption.credits) {
    const credit = account.credits.find((candidate) => candidate?.creditId === restoredCredit.creditId);
    if (credit && optionalNonNegativeNumber(credit.freeHeadroom)) {
      credit.freeHeadroom = roundQuantity(credit.freeHeadroom + restoredCredit.units);
    }
  }
}

function failedDecision({ objective, reason, rejectedCandidates = [] }) {
  return {
    ok: false,
    schema: DISPATCHER_MAXIMIZE_CREDITS_VERSION,
    objective,
    reason,
    ranking: [],
    rejectedCandidates,
  };
}

function ledgerBalanceHash(ledgerView) {
  return normalizeHashRef(ledgerView.balanceHash ?? ledgerView.digest ?? stableHash(ledgerView));
}

function normalizeHashRef(value) {
  if (isJsonString(value) && SHA256_REF.test(value)) return value;
  if (isJsonString(value) && /^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  return stableHash(value);
}

function stableHash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function requireCategory(category) {
  if (!DISPATCH_CATEGORIES.has(category)) {
    throw new TypeError("category must be runner or build-machine");
  }
  return category;
}

function requireObjective(objective) {
  if (!OBJECTIVES.has(objective)) {
    throw new TypeError("objective must be maximize-credits");
  }
  return objective;
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function optionalInstant(value, fieldName) {
  if (value === undefined || value === null) return null;
  return requireInstant(value, fieldName);
}

function requireInstant(value, fieldName) {
  const timestamp = requireString(value, fieldName);
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return new Date(parsed).toISOString();
}

function requirePositiveNumber(value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be greater than 0`);
  }
  return value;
}

function requirePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeNumber(value, fieldName, fallback) {
  if (value === undefined) return fallback;
  if (!optionalNonNegativeNumber(value)) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }
  return value;
}

function optionalNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function assertObject(value, fieldName) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
}

function roundCost(value) {
  return Number(value.toFixed(12));
}

function roundQuantity(value) {
  return Number(value.toFixed(9));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
