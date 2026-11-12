/**
 * The full GitHub Pages lifecycle the consumer pact declares: first publish
 * to an absent branch, an update on top of the observed head, a build
 * request, a lost blob reply resolved by lookup, a `/docs` publish, a Pages
 * deployment observed until it is live, an unpublish, and every refusal the
 * realizer types: a revoked token (401), a repository invisible to the token
 * (404), primary and secondary rate limits (403), a token without
 * contents: write (403) and a non-fast-forward ref update (422). Every request
 * and its response is recorded.
 */
import type {
	HttpTransport,
	ResolveOutcome,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	GITHUB_PAGES_SITE_PRODUCT_ID,
	type GithubPagesResolverOptions,
	githubResolverRegistry,
} from "../../src/index.js";
import {
	ARTIFACT_DIGEST,
	githubWorld,
	memoryStore,
	OIDC,
	options,
	request,
	SITE_DEPLOY,
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
	const store = memoryStore(
		...SITE_V1.blobs,
		...SITE_V2.blobs,
		...SITE_DEPLOY.blobs,
	);
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
	deployment.artifacts.set(42, { digest: ARTIFACT_DIGEST, expired: false });
	const deploymentRequest = request({
		publishMode: "pages-deployment",
		branch: undefined,
		path: undefined,
		artifactDigest: SITE_DEPLOY.digest,
		actionsArtifactId: 42,
		actionsArtifactDigest: ARTIFACT_DIGEST,
	});
	const deployer = resolver({ resolveDeploymentOidcToken: async () => OIDC });
	const created = await deployer.reconcile(
		deploymentRequest,
		record(deployment),
	);
	deployment.setDeploymentStatus(created.outputs.pagesBuildVersion, "succeed");
	await deployer.reconcile(deploymentRequest, record(deployment));

	// Refusals: each is recorded with the headers and error body GitHub sends.
	const refused = async (run: () => Promise<ResolveOutcome>) => {
		try {
			await run();
		} catch {
			return;
		}
		throw new Error("lifecycle: expected a refusal");
	};
	const revoked = githubWorld();
	await refused(() =>
		resolver({ resolveCredential: async () => "ghp_revoked" }).reconcile(
			request(),
			record(revoked),
		),
	);
	const invisible = githubWorld({ visible: false });
	await refused(() => resolver().reconcile(request(), record(invisible)));
	const limited = githubWorld();
	limited.faults.rateLimitOnce = true;
	await refused(() => resolver().reconcile(request(), record(limited)));
	const throttled = githubWorld();
	throttled.faults.secondaryRateLimitOnce = true;
	await refused(() => resolver().reconcile(request(), record(throttled)));
	const readOnly = githubWorld({ writable: false });
	await refused(() => resolver().reconcile(request(), record(readOnly)));
	const raced = githubWorld();
	await resolver().reconcile(request(), raced.transport);
	raced.faults.racingWriter = true;
	await refused(() =>
		resolver().reconcile(
			request({ artifactDigest: SITE_V2.digest }),
			record(raced),
		),
	);
	return seen;
}
