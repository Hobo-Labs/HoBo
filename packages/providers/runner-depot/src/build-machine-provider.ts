import type {
	BuildMachineProvider,
	CreditBudget,
	ExecutionHostBuild,
	ImageRef,
} from "@hobo/runner-github";
import {
	BUILD_MACHINE_CATEGORY,
	CreditExhaustedError,
	OCI_IMAGE_MANIFEST_MEDIA_TYPE,
} from "@hobo/runner-github";

import type { DepotClient } from "./depot-client.js";
import { DEPOT_PROVIDER_ID, executionHostManifest } from "./manifest.js";

// public-contract: the past-tense fact recorded per build's cache outcome.
export const BUILD_CACHE_HIT_OBSERVED = "build.CacheHitObserved";
// public-contract: the shared-cache lane Depot accelerates builds with.
export const DEPOT_CACHE_LANE = "depot-shared-cache";
// public-contract: typed gate when no BuildKit executor is wired.
export const DEPOT_EXECUTOR_MISSING = "DEPOT_EXECUTOR_MISSING";

export class DepotExecutorMissingError extends Error {
	readonly code = DEPOT_EXECUTOR_MISSING;
	constructor() {
		super(
			"runner-depot: no BuildKit executor wired — the live lane drives the `depot` CLI against the registered build; inject an executor for the replay lane.",
		);
		this.name = "DepotExecutorMissingError";
	}
}

// The cache-hit fact surfaced per build: which registered Depot build
// produced the image, the OBSERVED shared-cache hit ratio and the metered
// units actually consumed — appended by the caller's actor so effective
// per-build cost stays auditable from the log (a warm cache does less
// metered work for the identical build).
export interface CacheHitFact {
	readonly type: typeof BUILD_CACHE_HIT_OBSERVED;
	readonly buildId: string;
	readonly depotBuildId: string;
	readonly providerId: string;
	readonly cacheLane: typeof DEPOT_CACHE_LANE;
	readonly cacheHitRatio: number;
	readonly meteredUnits: number;
	readonly source: "observed-executor";
}

// What actually ran the registered build (the `depot` CLI/BuildKit in the
// live lane; a fixture in the replay lane): reports the pushed digest, the
// observed cache-hit ratio and the metered build minutes.
export interface DepotBuildExecutor {
	execute(input: {
		readonly buildId: string;
		readonly depotBuildId: string;
		readonly buildToken: string;
		readonly imageName: string;
	}): Promise<{
		readonly digest: string;
		readonly cacheHitRatio: number;
		readonly meteredUnits: number;
	}>;
}

export interface DepotBuildMachineProviderOptions {
	// The real Depot BuildService client (injected fetch inside).
	readonly client: DepotClient;
	// The registry namespace published images live under (registry.depot.dev
	// project or a pushed-to registry owner).
	readonly registry: string;
	// The BuildKit executor. REQUIRED in practice: the live lane wires the
	// depot CLI; the replay lane injects a fixture. Missing wiring fails
	// closed with the typed gate instead of fabricating an image.
	readonly executor?: DepotBuildExecutor;
	readonly id?: string;
	// Remaining prepaid/free units — the Dispatcher's reservation against the
	// CreditLedgerView (Plan 5). Defaults to unbounded.
	readonly creditBudget?: CreditBudget;
	// Receives the observed cache-hit fact for the caller to append.
	readonly onFact?: (fact: CacheHitFact) => void;
}

// The REAL Depot BuildMachineProvider (`hobo:build-machine`, Depot's core
// product): `execute(build)` registers the build with the BuildService
// (CreateBuild -> per-build token), hands it to the BuildKit executor on
// Depot infrastructure, and returns the pullable ImageRef. Every build
// surfaces its OBSERVED shared-cache hit ratio + metered units as a
// past-tense fact — the second identical build demonstrates the speedup in
// the log, and only ACTUAL metered units debit the credit budget. Credit
// exhaustion throws the typed `credit.exhausted` failure before any call.
export function createDepotBuildMachineProvider(
	options: DepotBuildMachineProviderOptions,
): BuildMachineProvider {
	const id = options.id ?? DEPOT_PROVIDER_ID;
	const creditBudget = options.creditBudget ?? {
		remainingUnits: Number.POSITIVE_INFINITY,
	};

	return {
		id,
		category: BUILD_MACHINE_CATEGORY,
		capabilityManifest() {
			return executionHostManifest(BUILD_MACHINE_CATEGORY, { providerId: id });
		},
		async execute(build: ExecutionHostBuild): Promise<ImageRef> {
			if (build.buildId.length === 0) {
				throw new Error(
					"runner-depot: build.buildId must be a non-empty string",
				);
			}
			const estimatedUnits = build.estimatedUnits ?? 1;
			if ((creditBudget.remainingUnits ?? 0) < estimatedUnits) {
				throw new CreditExhaustedError(id, build.buildId, estimatedUnits);
			}
			if (!options.executor) {
				throw new DepotExecutorMissingError();
			}

			const handle = await options.client.createBuild();
			const imageName = build.imageName ?? build.buildId;
			const outcome = await options.executor.execute({
				buildId: build.buildId,
				depotBuildId: handle.buildId,
				buildToken: handle.buildToken,
				imageName,
			});
			if (!outcome.digest.startsWith("sha256:")) {
				throw new Error(
					`runner-depot: executor returned a non-digest image ref for ${build.buildId}`,
				);
			}
			// Warm cache = fewer ACTUAL metered minutes for the identical build;
			// debit what was observed, not the cold estimate.
			creditBudget.remainingUnits -= outcome.meteredUnits;
			options.onFact?.({
				type: BUILD_CACHE_HIT_OBSERVED,
				buildId: build.buildId,
				depotBuildId: handle.buildId,
				providerId: id,
				cacheLane: DEPOT_CACHE_LANE,
				cacheHitRatio: outcome.cacheHitRatio,
				meteredUnits: outcome.meteredUnits,
				source: "observed-executor",
			});
			return {
				mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
				uri: `oci://${options.registry}/${imageName}@${outcome.digest}`,
				digest: outcome.digest,
			};
		},
	};
}
