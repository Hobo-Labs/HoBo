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
	readonly client: DepotClient;
	readonly registry: string;
	readonly executor?: DepotBuildExecutor;
	readonly id?: string;
	readonly creditBudget?: CreditBudget;
	readonly onFact?: (fact: CacheHitFact) => void;
}

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
