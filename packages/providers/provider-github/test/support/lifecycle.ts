/**
 * The full GitHub Pages lifecycle the consumer pact declares: first publish
 * to an absent branch, an update on top of the observed head, a build
 * request, a lost blob reply resolved by lookup, a `/docs` publish, a Pages
 * deployment, and an unpublish. Every request and its response is recorded.
 */
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	GITHUB_PAGES_SITE_PRODUCT_ID,
	type GithubPagesResolverOptions,
	githubResolverRegistry,
} from "../../src/index.js";
import {
	githubWorld,
	memoryStore,
	OIDC,
	options,
	request,
	SITE_V1,
	SITE_V2,
} from "./world.js";

export interface Exchange {
	readonly request: TransportRequest;
	readonly response: TransportResponse;
}

export async function recordLifecycle(): Promise<Exchange[]> {
	const seen: Exchange[] = [];
	const record =
		(world: ReturnType<typeof githubWorld>): HttpTransport =>
		async (entry) => {
			const response = await world.transport(entry);
			seen.push({ request: entry, response });
			return response;
		};
	const store = memoryStore(...SITE_V1.blobs, ...SITE_V2.blobs);
	const resolver = (overrides: Partial<GithubPagesResolverOptions> = {}) => {
		const found = githubResolverRegistry(options(store, overrides)).get(
			GITHUB_PAGES_SITE_PRODUCT_ID,
		);
		if (!found) throw new Error("GitHub Pages resolver is not registered");
		return found;
	};

	const branch = githubWorld();
	branch.faults.autoBuild = false;
	await resolver().reconcile(request(), record(branch));
	await resolver().reconcile(request(), record(branch));
	branch.finishBuild();
	branch.faults.dropReply = "/git/blobs";
	await resolver().reconcile(
		request({ artifactDigest: SITE_V2.digest }),
		record(branch),
	);
	await resolver().delete(request(), record(branch));

	const docs = githubWorld({ sourceBranch: "main", sourcePath: "/docs" });
	await resolver().reconcile(
		request({ branch: "main", path: "/docs" }),
		record(docs),
	);
	await resolver().reconcile(
		request({ branch: "main", path: "/docs", artifactDigest: SITE_V2.digest }),
		record(docs),
	);

	const deployment = githubWorld({ buildType: "workflow" });
	deployment.artifacts.set(42, {
		digest: `sha256:${"a".repeat(64)}`,
		expired: false,
	});
	await resolver({ resolveDeploymentOidcToken: async () => OIDC }).reconcile(
		request({
			publishMode: "pages-deployment",
			branch: undefined,
			path: undefined,
			actionsArtifactId: 42,
			actionsArtifactDigest: `sha256:${"a".repeat(64)}`,
		}),
		record(deployment),
	);
	return seen;
}
