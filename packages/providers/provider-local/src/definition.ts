/**
 * Localhost product definitions for the seeded `yard:local` (ADR-0157).
 *
 * Definitions only. The engines live in `@hobo/runtime-local` (the single
 * local engine owner); this package declares the `ResourceDefinition`
 * semantics describing those realizations so composed selection can see
 * local products without any cloud account, key, or call.
 *
 * The denominator is the localhost seed in `@hobo/yards`
 * (`packages/yards/src/localhost-seed.ts`): nine distinct products over
 * eleven profile rows when every host capability is present. Only products
 * with a real engine in `packages/runtimes/runtime-local/src` are claimed
 * here — traced at {@link LOCAL_EVIDENCE_CHECKED_AT}:
 *
 * - `local:in-memory-queue` — `createLocalQueue` (`src/queue.ts`): leased
 *   at-least-once delivery with idempotent enqueue over an in-memory store.
 * - `local:sqlite-file` — `createRuntimeLocalEventStore`
 *   (`src/eventstore/eventstore.ts`) over `SqliteJournal` and
 *   `createNodeSqliteDriver` from `@hobo/storage-sqlite`, the SQLite file
 *   named by `defaultDbPath` (`src/eventstore/sqlite-store.ts`).
 * - `local:in-process-worker` — `createLocalRuntimeHost` (`src/host.ts`):
 *   private components run in-process through supplied fetch handlers.
 * - `local:node-http-server` — `createRuntimeLocalComponentHost`
 *   (`src/component-host.ts`): `handleHttp` over the WASI HTTP incoming
 *   handler. The loopback TCP front door is composition, in `@hobo/hobo`'s
 *   local-yard serve path, not an engine in this package.
 *
 * Everything else the seed names is a {@link LOCAL_ENGINE_GAPS} entry, with
 * the missing engine stated. Claiming one of those would let selection
 * pick a product nothing on the station can realize.
 *
 * Evidence is station-local and fails closed. The shipped constants carry
 * `evidenceSignatureValid: false`, no expiry, and conformance `unknown`:
 * an engine trace in this repo is a fact a composition can verify, not an
 * attestation this package may sign for itself. A composition root that
 * has run the local engines injects signature, expiry, and conformance
 * through {@link LocalDefinitionOverrides} — the same override seam the
 * claimable cloud definitions expose. There is no claim ceremony: the
 * station operator already owns these resources, `replace` is never
 * emitted (a stack replaces by delete+create), and no secret material is
 * minted — secret references are refs only, and the seed's secret-locator
 * product is a gap below because its engine is not in `runtime-local`.
 */

import { create } from "@bufbuild/protobuf";
import type {
	BindleRuntime,
	ProfileImplementation,
	SelectionCandidate,
} from "@hobo/capability-profiles";
import { capability } from "@hobo/core";

import {
	type LocalEngineGapRecord,
	LocalEngineGapRecordSchema,
} from "./_generated/provider_local_pb.js";
import {
	type LocalResourceDefinition,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	semanticsToSelectionCandidate,
} from "./resource-definition.js";

// public-contract: provider id every catalog and receipt keys on; the same
// id `seedLocalhostYard` stamps on the localhost Yard.
export const LOCAL_PROVIDER_ID = "local" as const;

/** Date the runtime-local engines below were traced in this repo. */
// public-contract: evidence date a trust policy ages against.
export const LOCAL_EVIDENCE_CHECKED_AT = "2026-11-08";

// public-contract: stable Resource Definition identifiers, one per claimed
// seed product.
export const LOCAL_NODE_HTTP_SERVER_DEFINITION_ID =
	"local.node-http-server/v1" as const;
// public-contract: stable Resource Definition identifier for the sqlite product.
export const LOCAL_SQLITE_FILE_DEFINITION_ID = "local.sqlite-file/v1" as const;
// public-contract: stable Resource Definition identifier for the queue product.
export const LOCAL_IN_MEMORY_QUEUE_DEFINITION_ID =
	"local.in-memory-queue/v1" as const;
// public-contract: stable Resource Definition identifier for the worker product.
export const LOCAL_IN_PROCESS_WORKER_DEFINITION_ID =
	"local.in-process-worker/v1" as const;

// public-contract: strategy and permission refs the planner records. There
// is no claim, so the claim ref names that absence instead of a ceremony.
export const LOCAL_BOOTSTRAP_STRATEGY_REF =
	"bootstrap.local.station/v1" as const;
// public-contract: claim ref naming the absence of a claim ceremony.
export const LOCAL_CLAIM_STRATEGY_REF =
	"claim.local.none-station-owned/v1" as const;
// public-contract: compiler ref the plan records.
export const LOCAL_COMPILER_REF = "compiler.local.runtime-local/v1" as const;
// public-contract: permission profile ref the gatekeeper resolves.
export const LOCAL_PERMISSION_PROFILE_REF =
	"permission.local.station-operator/v1" as const;
// public-contract: trust evidence locator a station policy resolves and dates.
export const LOCAL_TRUST_EVIDENCE_REF =
	`trust.local.runtime-local@engine-traced@${LOCAL_EVIDENCE_CHECKED_AT}` as const;

/** Repo-relative engine sources standing behind every claim in this file. */
export const LOCAL_SOURCE_EVIDENCE_REFS: readonly string[] = Object.freeze([
	"packages/runtimes/runtime-local/src/queue.ts#createLocalQueue",
	"packages/runtimes/runtime-local/src/eventstore/eventstore.ts#createRuntimeLocalEventStore",
	"packages/runtimes/runtime-local/src/eventstore/sqlite-store.ts#defaultDbPath",
	"packages/runtimes/runtime-local/src/host.ts#createLocalRuntimeHost",
	"packages/runtimes/runtime-local/src/component-host.ts#createRuntimeLocalComponentHost",
	"packages/yards/src/localhost-seed.ts#seedLocalhostYard",
]);

export type LocalDefinitionOverrides = {
	/** Epoch ms after which station evidence must be re-gathered. */
	readonly evidenceExpiresAtMs?: number;
	/** True only after the composition verified station-local evidence. */
	readonly evidenceSignatureValid?: boolean;
	readonly secretCustodyAvailable?: boolean;
	/** `pass` only after a conformance run against the local engines. */
	readonly conformance?: ProfileImplementation["conformance"];
};

/**
 * A seed product this package refuses to claim, and why.
 *
 * Recorded rather than omitted, so the denominator is auditable: claimed
 * products plus these gaps are exactly the seed's distinct product ids.
 * The record type is the generated protobuf message
 * (`data-models/provider_local.proto`), never a hand-declared parallel.
 */
export type LocalEngineGap = LocalEngineGapRecord;

export const LOCAL_ENGINE_GAPS: readonly LocalEngineGap[] = Object.freeze([
	create(LocalEngineGapRecordSchema, {
		seedProductId: "local:filesystem-bucket",
		missingEngine: "a filesystem bucket (put/get/delete over a directory root)",
		reason:
			"no bucket engine exists in @hobo/runtime-local: nothing there stores objects under a directory root, so bucket.filesystem/v1 has no local realization to describe",
	}),
	create(LocalEngineGapRecordSchema, {
		seedProductId: "local:in-memory-kv",
		missingEngine: "an in-memory key-value store behind a kv port",
		reason:
			"no kv engine exists in @hobo/runtime-local: the in-memory Redis reference store in @hobo/kv-redis-compatible is a conformance fixture for testing adapters, not a station product, so kv.key-value/v1 is not claimed",
	}),
	create(LocalEngineGapRecordSchema, {
		seedProductId: "local:in-memory-secret-locator",
		missingEngine: "a station secret-locator store resolving refs at use time",
		reason:
			"no secret-locator engine exists in @hobo/runtime-local: SecretRef parsing lives in @hobo/bindings and mints nothing, so secret-ref.locator/v1 stays unclaimed (refs only, never material)",
	}),
	create(LocalEngineGapRecordSchema, {
		seedProductId: "local:in-memory-topic",
		missingEngine: "an in-memory ephemeral pub/sub fan-out",
		reason:
			"no ephemeral topic engine exists in @hobo/runtime-local: the SQLite EventStore subscribe path is durable and replayable, which is a different fidelity than topic.ephemeral-pubsub/v1",
	}),
	create(LocalEngineGapRecordSchema, {
		seedProductId: "local:static-file-server",
		missingEngine: "a static asset file server",
		reason:
			"no static-file engine exists in @hobo/runtime-local: the component host serves component HTTP handlers, not prebuilt assets from a directory, so web.static/v1 is not claimed",
	}),
]);

const LOGICAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/**
 * The deterministic physical name for a local resource.
 *
 * Pure: the same seed product and logical id always produce the same name,
 * so a crashed apply re-derives the name it already created instead of
 * minting a second resource. The logical id is a bounded slug — anything
 * path-shaped is refused rather than sanitized, because a name that
 * silently changed spelling would orphan the resource it replaced.
 */
export function deterministicLocalResourceName(
	seedProductId: string,
	logicalId: string,
): string {
	const product = seedProductId.startsWith("local:")
		? seedProductId.slice("local:".length)
		: "";
	if (!LOGICAL_ID_PATTERN.test(product)) {
		throw new TypeError(
			`seed product id must look like local:<slug> (got ${JSON.stringify(seedProductId)})`,
		);
	}
	if (!LOGICAL_ID_PATTERN.test(logicalId) || logicalId.includes("..")) {
		throw new TypeError(
			`logical id must be a non-empty slug of [a-z0-9._-] (got ${JSON.stringify(logicalId)})`,
		);
	}
	return `hobo-local--${product}--${logicalId}`;
}

function implementation(
	profileId: string,
	productSlug: string,
	conformance: ProfileImplementation["conformance"],
): ProfileImplementation {
	return {
		profileId,
		versionRange: ">=1",
		realization: "native",
		// The suffix says what was actually done: the engine code was traced
		// in this repo. It is not a live conformance run and does not say so.
		conformanceRef: `hobo.conformance/${profileId}#local.${productSlug}@engine-traced@${LOCAL_EVIDENCE_CHECKED_AT}`,
		conformance,
	};
}

type LocalProduct = {
	readonly id: string;
	readonly port: string;
	readonly seedProductId: string;
	readonly slug: string;
	readonly displayName: string;
	readonly profiles: readonly string[];
	readonly executorRef: string;
	/**
	 * Workload runtime models the runtime-local engine actually serves.
	 * `BindleRuntime` has no "station-local" member, so products that only
	 * serve in-station callers (queue, sqlite) claim none.
	 */
	readonly runtimeModels: readonly BindleRuntime[];
	readonly bindingProfiles: readonly string[];
	readonly structuredCapabilities: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
	readonly supportsExport: boolean;
	readonly dataContinuity: "preserved" | "discarded" | "not-applicable";
	readonly remediationCode: string;
	readonly remediationMessage: string;
};

const STATION_LOCAL = {
	placement: "station-local",
	loopbackOnly: true,
	cloudCredentialsRequired: false,
	deterministicNaming: true,
	bootstrap: "station-local",
	claimBoundary: "none-station-owned",
} as const;

const LOCAL_PRODUCTS: readonly LocalProduct[] = Object.freeze([
	{
		id: LOCAL_NODE_HTTP_SERVER_DEFINITION_ID,
		port: "api",
		seedProductId: "local:node-http-server",
		slug: "node-http-server",
		displayName: "Local HTTP server (runtime-local component host)",
		// Both seed rows for this product: the same HTTP incoming-handler
		// engine answers api and inbound-webhook requests.
		profiles: [capability.api.http, capability.webhook.inboundHttp],
		executorRef: "executor.runtime-local.component-host/v1",
		runtimeModels: ["wasm"],
		bindingProfiles: ["binding.http/v1"],
		structuredCapabilities: {
			...STATION_LOCAL,
			http: true,
			inProcessComponentHost: true,
		},
		supportsExport: false,
		dataContinuity: "not-applicable",
		remediationCode: "local.engine-unavailable",
		remediationMessage:
			"The local HTTP realization needs the runtime-local component host on this station. If the host cannot start, bind api.http/v1 on a provider Yard instead of widening this definition.",
	},
	{
		id: LOCAL_SQLITE_FILE_DEFINITION_ID,
		port: "data",
		seedProductId: "local:sqlite-file",
		slug: "sqlite-file",
		displayName: "Local SQLite file (runtime-local EventStore journal)",
		// Both seed rows for this product: the SQLite file is the concrete
		// engine, and it is the station's relational store.
		profiles: [capability.data.sqlite, capability.data.relational],
		executorRef: "executor.runtime-local.sqlite-eventstore/v1",
		runtimeModels: [],
		// No sqlite binding profile exists in the standard vocabulary and
		// the typed data client is a separate layer's work; an empty list
		// is the honest answer.
		bindingProfiles: [],
		structuredCapabilities: {
			...STATION_LOCAL,
			sqliteFile: true,
			fileBacked: true,
			persistent: true,
		},
		// The file is the export: copying it copies the store.
		supportsExport: true,
		dataContinuity: "preserved",
		remediationCode: "local.sqlite-unavailable",
		remediationMessage:
			"The local data realization needs the SQLite toolchain the seed observed (capability:toolchain:sqlite). Install it and re-run capability discovery, or bind data.sqlite/v1 on a provider Yard.",
	},
	{
		id: LOCAL_IN_MEMORY_QUEUE_DEFINITION_ID,
		port: "queue",
		seedProductId: "local:in-memory-queue",
		slug: "in-memory-queue",
		displayName: "Local in-memory queue (runtime-local leased queue)",
		profiles: [capability.queue.atLeastOnce],
		executorRef: "executor.runtime-local.in-memory-queue/v1",
		runtimeModels: [],
		bindingProfiles: [],
		structuredCapabilities: {
			...STATION_LOCAL,
			atLeastOnce: true,
			leasedDelivery: true,
			idempotentEnqueue: true,
			inMemory: true,
			// Deliberately false, not omitted: a requirement for durable
			// delivery must be refused, not silently simulated.
			persistent: false,
		},
		supportsExport: false,
		// Restarting the station discards queued messages. Said out loud so
		// a portability report prices it instead of discovering it.
		dataContinuity: "discarded",
		remediationCode: "local.queue-not-durable",
		remediationMessage:
			"The local queue is in-memory fan-out with leases, not durable delivery. A requirement for persistence needs queue.at-least-once/v1 on a provider Yard with a durable queue.",
	},
	{
		id: LOCAL_IN_PROCESS_WORKER_DEFINITION_ID,
		port: "service",
		seedProductId: "local:in-process-worker",
		slug: "in-process-worker",
		displayName: "Local in-process worker (runtime-local host)",
		profiles: [capability.service.worker],
		executorRef: "executor.runtime-local.in-process-host/v1",
		// No runtime model claim: the in-process host runs supplied fetch
		// handlers (`isolateBoundary: "in_process"`), not wasm components.
		// Wasm belongs to the component host (`local:node-http-server`).
		runtimeModels: [],
		bindingProfiles: [],
		structuredCapabilities: {
			...STATION_LOCAL,
			inProcess: true,
		},
		supportsExport: false,
		dataContinuity: "not-applicable",
		remediationCode: "local.worker-needs-handler",
		remediationMessage:
			"The local worker realization runs supplied in-process handlers only (no OS sandbox). A component without an in-process handler needs a component-host Yard, not this product.",
	},
]);

function createLocalDefinition(
	product: LocalProduct,
	overrides: LocalDefinitionOverrides,
): LocalResourceDefinition {
	const conformance = overrides.conformance ?? "unknown";
	return {
		id: product.id,
		providerId: LOCAL_PROVIDER_ID,
		port: product.port,
		semantics: {
			schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
			productId: product.seedProductId,
			displayName: product.displayName,
			implementsProfiles: product.profiles.map((profileId) =>
				implementation(profileId, product.slug, conformance),
			),
			runtimeModels: product.runtimeModels,
			structuredCapabilities: product.structuredCapabilities,
			placementConstraints: [],
			producesBindingProfiles: product.bindingProfiles,
			requiresConnectivityProfiles: [],
			migrationProfiles: [],
			bootstrapStrategyRef: LOCAL_BOOTSTRAP_STRATEGY_REF,
			claimStrategyRef: LOCAL_CLAIM_STRATEGY_REF,
			compilerRef: LOCAL_COMPILER_REF,
			executorRef: product.executorRef,
			permissionProfileRef: LOCAL_PERMISSION_PROFILE_REF,
			trustEvidenceRef: LOCAL_TRUST_EVIDENCE_REF,
			sourceEvidenceRefs: LOCAL_SOURCE_EVIDENCE_REFS,
			remediation: [
				{
					code: product.remediationCode,
					message: product.remediationMessage,
				},
			],
			// First-party and in-repo, with no L2 live run behind it yet.
			providerClass: "experimental",
			...(overrides.evidenceExpiresAtMs !== undefined
				? { evidenceExpiresAtMs: overrides.evidenceExpiresAtMs }
				: undefined),
			evidenceSignatureValid: overrides.evidenceSignatureValid ?? false,
			// No creating party distinct from the station operator exists.
			creatorAuthorityAfterClaim: "absent",
			claimAtomicity: "single-resource",
			claimActionCount: 0,
			continuity: {
				endpoint: "preserved",
				data: product.dataContinuity,
				credentials: "not-applicable",
			},
			supportsExport: product.supportsExport,
			// Nothing is minted, so there is nothing to rotate.
			supportsRotation: false,
			// False until a down loop exists: nothing here can revoke
			// access to a created resource, and the ADR must not claim it.
			supportsRevocation: false,
			// The operator's own machine. HoBo sponsors nothing.
			sponsorExposureMinorUnits: 0,
			secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
		},
	};
}

export function createLocalDefinitions(
	overrides: LocalDefinitionOverrides = {},
): readonly LocalResourceDefinition[] {
	return Object.freeze(
		LOCAL_PRODUCTS.map((product) =>
			createLocalDefinition(product, overrides),
		).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	);
}

/** Every claimed local product, sorted by id as {@link createLocalDefinitions} declares them. */
export const LOCAL_DEFINITIONS: readonly LocalResourceDefinition[] =
	createLocalDefinitions();

export function localCandidates(
	overrides: LocalDefinitionOverrides = {},
): readonly SelectionCandidate[] {
	return Object.freeze(
		createLocalDefinitions(overrides).map(semanticsToSelectionCandidate),
	);
}

/** The shipped-constant projection. Fails closed in selection, on purpose. */
export const LOCAL_CANDIDATES: readonly SelectionCandidate[] =
	localCandidates();
