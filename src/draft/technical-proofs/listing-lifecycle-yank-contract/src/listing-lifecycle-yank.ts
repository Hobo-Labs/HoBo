import { isJsonString, isJsonObject } from "./json.js";
export const LISTING_LIFECYCLE_YANK_CONTRACT = "hobo.listing-lifecycle-yank/v1";

const YANK_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);

export function createListingLifecycle() {
  const events = [];
  const listingsById = new Map();
  const yanksByListingId = new Map();
  const runningSetsById = new Map();
  const remediationObligations = [];

  return Object.freeze({
    certify(listing) {
      const certified = normalizeCertifiedListing(listing);
      listingsById.set(certified.listingId, certified);
      appendEvent(events, {
        type: "listing.Certified",
        contract: LISTING_LIFECYCLE_YANK_CONTRACT,
        listingId: certified.listingId,
        name: certified.name,
        version: certified.version,
        kind: certified.kind,
        publisher: clone(certified.publisher),
        artifact: clone(certified.artifact),
        certification: clone(certified.certification)
      });
      return clone(certified);
    },

    yank(command = {}) {
      const listing = listingsById.get(command.listingId);
      if (!listing || listing.status !== "Certified") {
        return rejected(["listing.not_certified"]);
      }
      const severity = normalizeSeverity(command.severity);
      if (!severity) {
        return rejected(["yank.severity_invalid"]);
      }
      if (!canYank({ actor: command.actor, listing })) {
        return rejected(["actor.unauthorized"]);
      }

      const yanked = Object.freeze({
        ...listing,
        status: "Yanked",
        yank: Object.freeze({
          reason: requireString(command.reason, "reason"),
          severity,
          occurredAt: command.occurredAt ?? null,
          actor: clone(command.actor)
        })
      });
      listingsById.set(yanked.listingId, yanked);
      yanksByListingId.set(yanked.listingId, yanked.yank);

      const event = {
        type: "listing.Yanked",
        contract: LISTING_LIFECYCLE_YANK_CONTRACT,
        listingId: yanked.listingId,
        name: yanked.name,
        version: yanked.version,
        reason: yanked.yank.reason,
        severity,
        actor: clone(command.actor),
        occurredAt: command.occurredAt ?? null
      };
      appendEvent(events, event);
      const policy = evaluateYankPolicy({ severity, policyOverride: command.policyOverride });
      const remediationObligation = policy.requiresRemediationObligation
        ? createRemediationObligation({
          listing: yanked,
          yank: yanked.yank,
          occurredAt: command.occurredAt ?? null
        })
        : null;
      if (remediationObligation) {
        remediationObligations.push(remediationObligation);
        appendEvent(events, remediationObligation);
      }

      return Object.freeze({
        ok: true,
        contract: LISTING_LIFECYCLE_YANK_CONTRACT,
        reasons: Object.freeze([]),
        listing: clone(yanked),
        event: clone(event),
        policy: clone(policy),
        remediationObligation: remediationObligation ? clone(remediationObligation) : null
      });
    },

    discovery() {
      return [...listingsById.values()]
        .filter((listing) => listing.status === "Certified" && !yanksByListingId.has(listing.listingId))
        .map(clone);
    },

    registerRunningSet(set) {
      const runningSet = normalizeRunningSet(set);
      runningSetsById.set(runningSet.setId, runningSet);
      return clone(runningSet);
    },

    doctor() {
      const findings = [...runningSetsById.values()]
        .flatMap((set) => set.pinnedListings
          .filter((pin) => yanksByListingId.has(pin.listingId))
          .map((pin) => {
            const yank = yanksByListingId.get(pin.listingId);
            const listing = listingsById.get(pin.listingId);
            return {
              type: "listing.yanked.pinned-set",
              contract: LISTING_LIFECYCLE_YANK_CONTRACT,
              setId: set.setId,
              listingId: pin.listingId,
              severity: yank.severity,
              incidentClass: "security-response",
              remediation: `Migrate ${set.setId} to a non-yanked version or Matching equivalent through a gated deployment.`,
              listing: clone(listing)
            };
          }));

      return Object.freeze({
        ok: findings.length === 0,
        contract: LISTING_LIFECYCLE_YANK_CONTRACT,
        findings: deepFreeze(findings)
      });
    },

    resolvePinnedListing(query = {}) {
      const set = runningSetsById.get(query.setId);
      const pin = set?.pinnedListings.find((candidate) => candidate.listingId === query.listingId);
      const listing = listingsById.get(query.listingId);
      if (!set || !pin || !listing) {
        return Object.freeze({
          ok: false,
          contract: LISTING_LIFECYCLE_YANK_CONTRACT,
          flagged: false,
          reasons: Object.freeze(["pinned_listing.not_found"]),
          listing: null
        });
      }

      return Object.freeze({
        ok: true,
        contract: LISTING_LIFECYCLE_YANK_CONTRACT,
        flagged: yanksByListingId.has(query.listingId),
        reasons: Object.freeze([]),
        listing: clone(listing),
        pin: clone(pin)
      });
    },

    canDeploy(command = {}) {
      const listingId = command.selection?.listingId;
      const yank = yanksByListingId.get(listingId);
      if (yank) {
        return Object.freeze({
          ok: false,
          contract: LISTING_LIFECYCLE_YANK_CONTRACT,
          decision: "hard-fail",
          reason: "listing.yanked",
          remediation: "Pick a non-yanked version or a Matching equivalent before deploying.",
          evidence: Object.freeze({
            listingId,
            operation: command.operation ?? null,
            severity: yank.severity,
            yankedAt: yank.occurredAt
          })
        });
      }

      return Object.freeze({
        ok: true,
        contract: LISTING_LIFECYCLE_YANK_CONTRACT,
        decision: "allow",
        reason: "listing.deployable",
        remediation: null,
        evidence: Object.freeze({
          listingId: listingId ?? null,
          operation: command.operation ?? null
        })
      });
    },

    events() {
      return events.map(clone);
    },

    obligations() {
      return remediationObligations.map(clone);
    }
  });
}

function evaluateYankPolicy({ severity, policyOverride }) {
  const override = isPlainObject(policyOverride) ? policyOverride : {};
  return Object.freeze({
    severity,
    autoPage: override.autoPage ?? severity === "critical",
    requiresRemediationObligation: severity === "critical",
    override: clone(override)
  });
}

function createRemediationObligation({ listing, yank, occurredAt }) {
  return Object.freeze({
    type: "policy.ObligationCreated",
    contract: LISTING_LIFECYCLE_YANK_CONTRACT,
    listingId: listing.listingId,
    obligationId: `obligation:${listing.listingId}:replace-yanked-listing`,
    severity: "critical",
    reason: "listing.yanked.critical",
    action: "replace-yanked-listing",
    remediation: "Drive a gated migration to a non-yanked version or Matching equivalent.",
    sourceEventType: "listing.Yanked",
    yankedAt: yank.occurredAt,
    occurredAt
  });
}

function normalizeCertifiedListing(listing) {
  if (!isPlainObject(listing)) {
    throw new Error("certified listing must be an object");
  }
  const normalized = {
    ...clone(listing),
    listingId: requireString(listing.listingId, "listingId"),
    status: "Certified",
    name: requireString(listing.name, "name"),
    version: requireString(listing.version, "version"),
    kind: requireString(listing.kind, "kind")
  };
  if (!isPlainObject(normalized.publisher)) {
    throw new Error("certified listing requires publisher");
  }
  if (!isPlainObject(normalized.artifact)) {
    throw new Error("certified listing requires artifact");
  }
  return Object.freeze(normalized);
}

function normalizeRunningSet(set) {
  if (!isPlainObject(set)) {
    throw new Error("running Set must be an object");
  }
  const pinnedListings = Array.isArray(set.pinnedListings) ? set.pinnedListings : [];
  const normalized = {
    ...clone(set),
    setId: requireString(set.setId, "setId"),
    status: requireString(set.status, "status"),
    pinnedListings: pinnedListings.map((pin) => ({
      ...clone(pin),
      listingId: requireString(pin?.listingId, "pinnedListings[].listingId")
    }))
  };
  return deepFreeze(normalized);
}

function canYank({ actor, listing }) {
  if (!isPlainObject(actor)) {
    return false;
  }
  if (actor.trustDomain && actor.trustDomain === listing.publisher?.trustDomain) {
    return true;
  }
  const roles = Array.isArray(actor.roles) ? actor.roles : [];
  return roles.includes("yard-security-policy-admin");
}

function normalizeSeverity(value) {
  if (value === undefined) {
    return "low";
  }
  return YANK_SEVERITIES.includes(value) ? value : null;
}

function appendEvent(events, event) {
  events.push(Object.freeze({
    seq: events.length + 1,
    ...event
  }));
}

function rejected(reasons) {
  return Object.freeze({
    ok: false,
    contract: LISTING_LIFECYCLE_YANK_CONTRACT,
    reasons: Object.freeze(reasons),
    listing: null,
    event: null
  });
}

function requireString(value, field) {
  if (!isJsonString(value) || value.trim().length === 0) {
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  return value;
}
