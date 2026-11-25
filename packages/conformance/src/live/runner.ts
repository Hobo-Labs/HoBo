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

export type LiveResourceHandle = {
	readonly id: string;
	readonly kind: string;
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
	readonly now: () => number;
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
