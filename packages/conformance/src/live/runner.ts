/**
 * The guarded live conformance runner.
 *
 * This is the only code path in the package that is allowed to touch a real
 * provider, and it is built so that the interesting failure — "the run died
 * halfway through" — still ends with the account clean and the evidence
 * honest. Provisioning goes through a port, every resource carries the run's
 * unique tag, the count is capped by the operator's grant, and cleanup runs in
 * a `finally` so a thrown executor cannot leak a resource.
 *
 * Nothing here reads a clock, a random source, the environment, or the
 * filesystem directly: the guard is handed an environment, and instants and
 * run ids arrive as ports, so the whole runner is exercisable offline.
 */
import type {
	CreatorAuthorityAfterClaim,
	ProviderClass,
} from "@hobo/capability-profiles";
import type { EvidenceSourceRef } from "@hobo/trust";

import {
	type AnonymousExecutorPorts,
	runAnonymousConformance,
} from "../suites/anonymous/index.js";
import type { AnonymousConformanceReport } from "../suites/anonymous/types.js";
import {
	type AnonymousTrustEvidenceArtifact,
	CLEANUP_CHECK,
	type EvidenceSigner,
	emitAnonymousTrustEvidence,
} from "./evidence.js";
import { type LiveRunGrant, parseLiveRunGrant } from "./guard.js";

// public-contract: versions persisted live-conformance run records.
export const LIVE_RUN_SCHEMA = "hobo.conformance.live-run/v1" as const;

/** A resource the run created and is therefore responsible for destroying. */
export type LiveResourceHandle = {
	readonly id: string;
	readonly kind: string;
	/** The run tag this resource was created under. Checked before cleanup. */
	readonly runTag: string;
};

export type LiveResourceRequest = {
	readonly kind: string;
	readonly runTag: string;
	readonly sequence: number;
};

export type LiveCleanupOutcome = {
	readonly attempted: readonly string[];
	readonly destroyed: readonly string[];
	readonly leaked: readonly string[];
	readonly detail: string;
};

export type LiveConformancePorts = AnonymousExecutorPorts & {
	/** Injected clock. */
	readonly now: () => number;
	/** Injected entropy, used only for the run tag. */
	readonly newRunId: () => string;
	readonly provision: (
		request: LiveResourceRequest,
	) => Promise<LiveResourceHandle> | LiveResourceHandle;
	readonly cleanup: (
		handles: readonly LiveResourceHandle[],
	) => Promise<LiveCleanupOutcome> | LiveCleanupOutcome;
	readonly signer: EvidenceSigner;
};

export type LiveConformanceOptions = {
	readonly providerId: string;
	readonly productDefinitionId: string;
	readonly productDefinitionDigest: string;
	readonly adapterVersion: string;
	readonly providerClass: ProviderClass;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimActionCount: number;
	readonly sourceRefs: readonly EvidenceSourceRef[];
	/** Resource kinds to create up front, capped by the grant's budget. */
	readonly resourceKinds?: readonly string[];
	readonly freshnessWindowMs?: number;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly ports: LiveConformancePorts;
};

export type LiveConformanceResult = {
	readonly schema: typeof LIVE_RUN_SCHEMA;
	readonly grant: LiveRunGrant;
	readonly runTag: string;
	readonly reports: readonly AnonymousConformanceReport[];
	readonly cleanup: LiveCleanupOutcome;
	readonly artifact: AnonymousTrustEvidenceArtifact;
};

const DEFAULT_RESOURCE_KINDS: readonly string[] = ["database"];

/**
 * Run the anonymous dimension against a real provider and emit signed evidence.
 *
 * Refuses before creating anything if the grant is incomplete. After that the
 * shape is: provision tagged resources, run the four suites, always clean up,
 * then write down exactly what happened including a failed cleanup.
 */
export async function runLiveAnonymousConformance(
	options: LiveConformanceOptions,
): Promise<LiveConformanceResult> {
	const grant = parseLiveRunGrant({
		providerId: options.providerId,
		env: options.env,
	});
	const ports = options.ports;
	const runTag =
		grant.runTag ?? `hobo-conf-${grant.providerId}-${ports.newRunId()}`;
	const testedAtMs = ports.now();

	const requestedKinds = options.resourceKinds ?? DEFAULT_RESOURCE_KINDS;
	const kinds = requestedKinds.slice(0, grant.maximumResources);

	const handles: LiveResourceHandle[] = [];
	let reports: readonly AnonymousConformanceReport[] = [];
	let runError: unknown;

	try {
		for (const [sequence, kind] of kinds.entries()) {
			handles.push(await ports.provision({ kind, runTag, sequence }));
		}
		reports = await runAnonymousConformance(ports, {
			subjectId: options.productDefinitionId,
		});
	} catch (error) {
		runError = error;
	}

	// Cleanup is unconditional. A run that failed is exactly the run most
	// likely to have left something billable behind.
	const cleanup = await safeCleanup(ports, handles, runTag);

	if (runError !== undefined) {
		throw runError;
	}

	const artifact = emitAnonymousTrustEvidence({
		providerId: grant.providerId,
		productDefinitionId: options.productDefinitionId,
		productDefinitionDigest: options.productDefinitionDigest,
		adapterVersion: options.adapterVersion,
		providerClass: options.providerClass,
		providerDocsCheckedAt: grant.providerDocsCheckedAt,
		runTag,
		testedAtMs,
		reports,
		creatorAuthorityAfterClaim: options.creatorAuthorityAfterClaim,
		claimActionCount: options.claimActionCount,
		sourceRefs: options.sourceRefs,
		signer: ports.signer,
		additionalChecks: {
			[CLEANUP_CHECK]: cleanup.leaked.length === 0 ? "pass" : "fail",
		},
		...(options.freshnessWindowMs !== undefined
			? { freshnessWindowMs: options.freshnessWindowMs }
			: undefined),
	});

	return Object.freeze({
		schema: LIVE_RUN_SCHEMA,
		grant,
		runTag,
		reports,
		cleanup,
		artifact,
	});
}

/**
 * Destroy everything this run created.
 *
 * A handle carrying somebody else's run tag is refused rather than destroyed:
 * a cleanup routine that deletes untagged resources is a much worse bug than a
 * leaked one.
 */
async function safeCleanup(
	ports: LiveConformancePorts,
	handles: readonly LiveResourceHandle[],
	runTag: string,
): Promise<LiveCleanupOutcome> {
	const foreign = handles.filter((handle) => handle.runTag !== runTag);
	const own = handles.filter((handle) => handle.runTag === runTag);
	const attempted = own.map((handle) => handle.id);

	if (own.length === 0) {
		return {
			attempted: [],
			destroyed: [],
			leaked: foreign.map((handle) => handle.id),
			detail:
				foreign.length === 0
					? "no resources were created"
					: `refused to destroy ${foreign.length} resource(s) tagged for another run`,
		};
	}

	try {
		const outcome = await ports.cleanup(own);
		return {
			attempted,
			destroyed: [...outcome.destroyed],
			leaked: [...outcome.leaked, ...foreign.map((handle) => handle.id)],
			detail: outcome.detail,
		};
	} catch (error) {
		return {
			attempted,
			destroyed: [],
			leaked: [...attempted, ...foreign.map((handle) => handle.id)],
			detail: `cleanup threw: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
