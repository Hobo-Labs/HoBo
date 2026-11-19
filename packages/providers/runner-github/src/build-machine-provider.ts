import type { GithubActionsClient } from "./github-actions-client.js";
import {
	executionHostManifest,
	GITHUB_RUNNER_PROVIDER_ID,
} from "./manifest.js";
import {
	type RunTrackingOptions,
	trackDispatchedRun,
} from "./runner-provider.js";
import {
	BUILD_MACHINE_CATEGORY,
	type BuildMachineProvider,
	type CreditBudget,
	type ExecutionHostBuild,
	type ImageRef,
} from "./types.js";

export const BUILD_WORKFLOW_DEFAULT = "hobo-build.yml";
export const CREDIT_EXHAUSTED = "credit.exhausted";
export const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
	"application/vnd.oci.image.manifest.v1+json";

export class CreditExhaustedError extends Error {
	readonly code = CREDIT_EXHAUSTED;
	readonly providerId: string;
	readonly buildId: string;
	constructor(providerId: string, buildId: string, estimatedUnits: number) {
		super(
			`build-machine ${providerId} has insufficient credit for ${estimatedUnits} units`,
		);
		this.name = "CreditExhaustedError";
		this.providerId = providerId;
		this.buildId = buildId;
	}
}

export interface GithubBuildMachineProviderOptions {
	readonly client: GithubActionsClient;
	readonly owner: string;
	readonly id?: string;
	readonly workflow?: string;
	readonly ref?: string;
	readonly creditBudget?: CreditBudget;
	readonly tracking?: RunTrackingOptions;
}

export function createGithubBuildMachineProvider(
	options: GithubBuildMachineProviderOptions,
): BuildMachineProvider {
	const id = options.id ?? GITHUB_RUNNER_PROVIDER_ID;
	const workflow = options.workflow ?? BUILD_WORKFLOW_DEFAULT;
	const ref = options.ref ?? "main";
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
					"runner-github: build.buildId must be a non-empty string",
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
				},
			});
			const run = await trackDispatchedRun(
				options.client,
				build.workflow ?? workflow,
				options.tracking,
			);
			if (run.conclusion !== "success") {
				throw new Error(
					`runner-github: build run ${run.id} concluded ${run.conclusion ?? "unknown"} — no image published`,
				);
			}
			const digest = await options.client.latestContainerDigest(imageName);
			creditBudget.remainingUnits -= estimatedUnits;
			return {
				mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
				uri: `oci://ghcr.io/${options.owner}/${imageName}@${digest}`,
				digest,
			};
		},
	};
}
