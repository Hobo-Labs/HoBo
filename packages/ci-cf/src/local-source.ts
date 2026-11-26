import type {
	CiParams,
	CloudflareArtifacts,
	cloudflareArtifacts,
} from "@cloudflare/ci";
import type { CiSandbox } from "@cloudflare/ci/worker";

/** Same upstream adapter contract, with checkout confined to the local image. */
export function localSourceAdapter() {
	const accepts: ReturnType<typeof cloudflareArtifacts>["accepts"] = (source) =>
		source.provider === "cloudflare-artifacts" &&
		source.owner === "local" &&
		source.repo === "workspace";
	const assertSource: ReturnType<typeof cloudflareArtifacts>["assertSource"] = (
		source,
	) => {
		if (!accepts(source))
			throw new Error("local CI requires the image workspace");
	};
	return {
		// SDK 0.2.0's public getProvider() contract fixes this discriminator.
		// No Artifacts binding or Cloudflare source-control request is made.
		id: "cloudflare-artifacts",
		repository: { owner: "local", repo: "workspace" },
		accepts,
		assertSource,
		create: (): ReturnType<
			ReturnType<typeof cloudflareArtifacts>["create"]
		> => ({
			receiveEvent: async () => null,
			getSourceCheckout: async (source) => {
				assertSource({ ...source, provider: "cloudflare-artifacts" });
				return { kind: "archive", url: "file:///opt/hobo-ci/source.tar.gz" };
			},
			// Cross-run caches need source fingerprints. Local runs always execute.
			listTreeBlobs: async () => null,
			getStepCredentialEnv: async () => {
				throw new Error("local CI does not provide source-control credentials");
			},
			getPushCredentials: async () => {
				throw new Error("local CI does not push source");
			},
			createPullRequest: async () => ({ status: "skipped" }),
			startStepNotification: async () => null,
		}),
	} satisfies ReturnType<typeof cloudflareArtifacts>;
}

/** Force binding-backed backups even when Docker happens to provide /dev/fuse. */
export function localBackupOptions(
	options: Parameters<CiSandbox["createBackup"]>[0],
): Parameters<CiSandbox["createBackup"]>[0] {
	return { ...options, localBucket: true };
}

/** Fail before a runner starts when another preparation owns the dev port. */
export function assertLocalPreparation(
	params: CiParams<CloudflareArtifacts>,
	sha: string,
	preparationId: string,
): void {
	if (params.sha !== sha || params.providerData.namespace !== preparationId)
		throw new Error(
			"local preparation differs from the running dev session; stop dev and restart with the selected --directory",
		);
}
