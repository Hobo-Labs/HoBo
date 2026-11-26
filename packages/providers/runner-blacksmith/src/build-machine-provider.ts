import type {
	BuildMachineProvider,
	CreditBudget,
	ExecutionHostBuild,
	GithubActionsClient,
	ImageRef,
	RunTrackingOptions,
} from "@hobo/runner-github";
import {
	BUILD_MACHINE_CATEGORY,
	CreditExhaustedError,
	OCI_IMAGE_MANIFEST_MEDIA_TYPE,
	trackDispatchedRun,
} from "@hobo/runner-github";

import {
	BLACKSMITH_PROVIDER_ID,
	BLACKSMITH_RUNS_ON_DEFAULT,
	executionHostManifest,
} from "./manifest.js";

// public-contract: the default workflow file `execute(build)` dispatches.
export const BLACKSMITH_BUILD_WORKFLOW_DEFAULT = "hobo-build-blacksmith.yml";
// public-contract: the cache lane Blacksmith accelerates container builds with.
export const BLACKSMITH_CACHE_LANE = "sticky-disk";
// public-contract: the past-tense fact recorded for every accelerated build.
export const BUILD_CACHE_LANE_OBSERVED = "build.CacheLaneObserved";

// The cache-lane fact surfaced per build: which run built the image and which
// declared acceleration lane it used — appended by the caller's actor so
// effective build cost stays auditable from the log.
export interface CacheLaneFact {
	readonly type: typeof BUILD_CACHE_LANE_OBSERVED;
	readonly buildId: string;
	readonly providerId: string;
	readonly runId: number;
	readonly cacheLane: string;
	readonly source: "declared-provider";
}

export interface BlacksmithBuildMachineProviderOptions {
	// The real GitHub Actions client (injected fetch inside).
	readonly client: GithubActionsClient;
	// The GHCR owner segment of published image URIs (usually the org).
	readonly owner: string;
	readonly id?: string;
	readonly workflow?: string;
	readonly ref?: string;
	readonly runsOn?: string;
	// Remaining prepaid/free units — the Dispatcher's reservation against the
	// CreditLedgerView (Plan 5). Defaults to unbounded.
	readonly creditBudget?: CreditBudget;
	readonly tracking?: RunTrackingOptions;
	// Receives the cache-lane fact for the caller to append to the event store.
	readonly onFact?: (fact: CacheLaneFact) => void;
}

// The REAL Blacksmith BuildMachineProvider (`hobo:build-machine`): the
// BuildProvider engine executes on a Blacksmith fast machine with sticky-disk
// Docker-layer caching; `execute(build)` dispatches the build workflow,
// tracks the run, resolves the published GHCR digest into a pullable
// ImageRef, and surfaces the cache-lane fact. Credit exhaustion throws the
// typed `credit.exhausted` failure BEFORE any dispatch so the Dispatcher can
// re-route to the next-cheapest host.
export function createBlacksmithBuildMachineProvider(
	options: BlacksmithBuildMachineProviderOptions,
): BuildMachineProvider {
	const id = options.id ?? BLACKSMITH_PROVIDER_ID;
	const workflow = options.workflow ?? BLACKSMITH_BUILD_WORKFLOW_DEFAULT;
	const ref = options.ref ?? "main";
	const runsOn = options.runsOn ?? BLACKSMITH_RUNS_ON_DEFAULT;
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
					"runner-blacksmith: build.buildId must be a non-empty string",
				);
			}
			const estimatedUnits = build.estimatedUnits ?? 1;
			if ((creditBudget.remainingUnits ?? 0) < estimatedUnits) {
				throw new CreditExhaustedError(id, build.buildId, estimatedUnits);
			}

			const imageName = build.imageName ?? build.buildId;
			await options.client.dispatchWorkflow({
				workflow: build.workflow ?? workflow,
				ref: build.ref ?? ref,
				inputs: {
					...build.inputs,
					build_id: build.buildId,
					image: imageName,
					runs_on: runsOn,
				},
			});
			const run = await trackDispatchedRun(
				options.client,
				build.workflow ?? workflow,
				options.tracking,
			);
			if (run.conclusion !== "success") {
				throw new Error(
					`runner-blacksmith: build run ${run.id} concluded ${run.conclusion ?? "unknown"} — no image published`,
				);
			}
			const digest = await options.client.latestContainerDigest(imageName);
			creditBudget.remainingUnits -= estimatedUnits;
			options.onFact?.({
				type: BUILD_CACHE_LANE_OBSERVED,
				buildId: build.buildId,
				providerId: id,
				runId: run.id,
				cacheLane: BLACKSMITH_CACHE_LANE,
				source: "declared-provider",
			});
			return {
				mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
				uri: `oci://ghcr.io/${options.owner}/${imageName}@${digest}`,
				digest,
			};
		},
	};
}
