/**
 * Product definitions for the Cloudflare temporary-account Yard.
 *
 * These are data. They contain no I/O and no provider calls — Matching consumes
 * them through `selectCapabilityImplementation`, and the effectful driver lives
 * in `temporary-account.ts`.
 *
 * The interesting entries are the ones that decline to claim something:
 * `cloudflare.temporary-d1/v1` implements `data.sqlite/v1` and
 * `data.relational/v1` but **never** `data.postgres/v1`, and
 * `cloudflare.temporary-hyperdrive/v1` implements no capability profile at all
 * because it is connectivity to somebody else's database.
 *
 * Every limit traces to the published supported-resources table
 * (https://developers.cloudflare.com/workers/platform/claim-deployments/,
 * re-read 2026-08-08).
 */
import type { SelectionCandidate } from "@hobo/capability-profiles";

import {
	CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT,
	CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL,
} from "./temporary-account-resources.js";

/**
 * Trust-evidence expiry stamped on the shipped definitions.
 *
 * A fixed instant rather than `Date.now()` keeps the definitions pure and the
 * selection tests deterministic; a Yard that re-verifies conformance replaces it
 * through {@link withEvidenceExpiry}.
 */
export const CLOUDFLARE_TEMPORARY_EVIDENCE_EXPIRES_AT_MS = Date.parse(
	"2027-02-08T00:00:00.000Z",
);

export const CLOUDFLARE_TEMPORARY_DEFINITION_SOURCE = {
	url: CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL,
	checkedAt: CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT,
} as const;

const CONFORMANCE_PREFIX = "conformance.cloudflare.temporary-account";

type ProfileClaim = {
	readonly profileId: string;
	readonly conformance?: "pass" | "fail" | "unknown";
};

function implement(
	claims: readonly ProfileClaim[],
): SelectionCandidate["implementsProfiles"] {
	return claims.map((claim) => ({
		profileId: claim.profileId,
		versionRange: ">=1",
		realization: "native" as const,
		conformanceRef: `${CONFORMANCE_PREFIX}/${claim.profileId}`,
		conformance: claim.conformance ?? ("pass" as const),
	}));
}

/** Shared trust posture for every temporary-account product. */
const TEMPORARY_BASE = {
	providerId: "cloudflare",
	runtimeModels: ["serverless_faas", "wasm"],
	migrationProfiles: [],
	providerClass: "established",
	evidenceExpiresAtMs: CLOUDFLARE_TEMPORARY_EVIDENCE_EXPIRES_AT_MS,
	evidenceSignatureValid: true,
	// Claiming does not grant HoBo continuing access: a separate ceremony does.
	creatorAuthorityAfterClaim: "reauthorization-required",
	// One claim covers the whole account and everything inside it.
	claimAtomicity: "provider-bundled",
	claimActionCount: 1,
	supportsRotation: true,
	supportsRevocation: true,
	sponsorExposureMinorUnits: 0,
	hasRegisteredDriver: true,
	secretCustodyAvailable: true,
} as const satisfies Partial<SelectionCandidate>;

/** Continuity for resources that survive the claim in place. */
const CONTINUITY_PRESERVED = {
	endpoint: "preserved",
	data: "preserved",
	credentials: "revoked",
} as const satisfies SelectionCandidate["continuity"];

/**
 * Binding profiles a Cloudflare Worker binding produces.
 *
 * `binding.cloudflare-worker-binding/v1` is a provider extension of the open
 * binding-profile namespace: D1, KV, Durable Objects, and Queues reach the
 * workload as a Worker binding, not as a network endpoint with a credential.
 */
// public-contract: binding profile advertised by Worker definitions.
export const CLOUDFLARE_WORKER_BINDING_PROFILE =
	"binding.cloudflare-worker-binding/v1" as const;

export const CLOUDFLARE_TEMPORARY_WORKERS_WEB: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-workers-web/v1",
	implementsProfiles: implement([
		{ profileId: "web.static/v1" },
		{ profileId: "web.hosted/v1" },
	]),
	structuredCapabilities: {
		maxFileCount: 1000,
		maxFileMebibytes: 5,
		httpsOnly: true,
		// workers.dev only until the account is claimed.
		customDomain: false,
		spaFallback: true,
		immutableCaching: true,
		customRedirects: true,
		customHeaders: true,
	},
	producesBindingProfiles: ["binding.http/v1"],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: true,
};

export const CLOUDFLARE_TEMPORARY_WORKERS_API: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-workers-api/v1",
	implementsProfiles: implement([{ profileId: "api.http/v1" }]),
	structuredCapabilities: {
		streaming: true,
		websocketUpgrade: true,
		egress: true,
	},
	producesBindingProfiles: ["binding.http/v1"],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: true,
};

/**
 * Queue-driven compute.
 *
 * Note what is absent: `service.scheduled/v1`. Cron Triggers are not in the
 * supported-resources table, and the ability to run a worker never implies the
 * ability to schedule one.
 */
export const CLOUDFLARE_TEMPORARY_QUEUE_CONSUMER: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-queue-consumer/v1",
	implementsProfiles: implement([{ profileId: "service.queue-consumer/v1" }]),
	structuredCapabilities: {
		maxQueues: 10,
	},
	producesBindingProfiles: [CLOUDFLARE_WORKER_BINDING_PROFILE],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: true,
};

/**
 * D1 in a temporary account.
 *
 * SQLite dialect and relational semantics, and that is the whole claim. A
 * requirement for `data.postgres/v1` must lose this candidate to an actual
 * PostgreSQL product; the refinement graph only flows child → ancestor.
 */
export const CLOUDFLARE_TEMPORARY_D1: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-d1/v1",
	implementsProfiles: implement([
		{ profileId: "data.sqlite/v1" },
		{ profileId: "data.relational/v1" },
	]),
	structuredCapabilities: {
		maxDatabaseCount: 1,
		maxDatabaseMegabytes: 100,
		maxTotalMegabytes: 100,
		sqliteDialect: true,
		transactions: true,
		constraints: true,
		jsonDocuments: true,
		preparedStatements: true,
		postgresWireProtocol: false,
	},
	producesBindingProfiles: [CLOUDFLARE_WORKER_BINDING_PROFILE],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: true,
};

export const CLOUDFLARE_TEMPORARY_KV: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-kv/v1",
	implementsProfiles: implement([{ profileId: "kv.key-value/v1" }]),
	structuredCapabilities: {
		namespaceLifecycle: true,
		bulkOperations: true,
	},
	producesBindingProfiles: [CLOUDFLARE_WORKER_BINDING_PROFILE],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: true,
};

export const CLOUDFLARE_TEMPORARY_DURABLE_OBJECT: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-durable-object/v1",
	implementsProfiles: implement([
		{ profileId: "kv.durable-object/v1" },
		{ profileId: "realtime.websocket/v1" },
	]),
	structuredCapabilities: {
		singleWriter: true,
		bidirectional: true,
		migrations: true,
	},
	producesBindingProfiles: [
		CLOUDFLARE_WORKER_BINDING_PROFILE,
		"binding.websocket/v1",
	],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: false,
};

export const CLOUDFLARE_TEMPORARY_QUEUE: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-queue/v1",
	implementsProfiles: implement([{ profileId: "queue.at-least-once/v1" }]),
	structuredCapabilities: {
		atLeastOnce: true,
		maxQueues: 10,
	},
	producesBindingProfiles: [CLOUDFLARE_WORKER_BINDING_PROFILE],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: false,
};

/**
 * Hyperdrive is connectivity, not a database.
 *
 * `implementsProfiles` is empty on purpose. Hyperdrive pools and accelerates a
 * connection to a database somebody else provisioned, so it produces a
 * `binding.postgresql/v1` and satisfies no `data.*` requirement whatsoever.
 */
export const CLOUDFLARE_TEMPORARY_HYPERDRIVE: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-hyperdrive/v1",
	implementsProfiles: [],
	structuredCapabilities: {
		connectivityOnly: true,
		maxConfigurations: 2,
		maxConnections: 10,
	},
	producesBindingProfiles: ["binding.postgresql/v1"],
	continuity: {
		endpoint: "preserved",
		data: "not-applicable",
		credentials: "revoked",
	},
	supportsExport: false,
};

export const CLOUDFLARE_TEMPORARY_WEBHOOK_REALTIME: SelectionCandidate = {
	...TEMPORARY_BASE,
	definitionId: "cloudflare.temporary-webhook-realtime/v1",
	implementsProfiles: implement([
		{ profileId: "webhook.inbound-http/v1" },
		{ profileId: "realtime.websocket/v1" },
	]),
	structuredCapabilities: {
		bidirectional: true,
	},
	producesBindingProfiles: ["binding.http/v1", "binding.websocket/v1"],
	continuity: CONTINUITY_PRESERVED,
	supportsExport: false,
};

export const CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS: readonly SelectionCandidate[] =
	Object.freeze([
		CLOUDFLARE_TEMPORARY_D1,
		CLOUDFLARE_TEMPORARY_DURABLE_OBJECT,
		CLOUDFLARE_TEMPORARY_HYPERDRIVE,
		CLOUDFLARE_TEMPORARY_KV,
		CLOUDFLARE_TEMPORARY_QUEUE,
		CLOUDFLARE_TEMPORARY_QUEUE_CONSUMER,
		CLOUDFLARE_TEMPORARY_WEBHOOK_REALTIME,
		CLOUDFLARE_TEMPORARY_WORKERS_API,
		CLOUDFLARE_TEMPORARY_WORKERS_WEB,
	]);

/** Re-stamp evidence freshness after a conformance run. */
export function withEvidenceExpiry(
	candidates: readonly SelectionCandidate[],
	evidenceExpiresAtMs: number,
): readonly SelectionCandidate[] {
	return candidates.map((candidate) => ({ ...candidate, evidenceExpiresAtMs }));
}
