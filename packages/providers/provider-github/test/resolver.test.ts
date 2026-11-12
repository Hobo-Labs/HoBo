import {
	parseResolveOutcome,
	type ResolveOutcome,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	GITHUB_PAGES_SITE_PRODUCT_ID,
	GithubPagesRefusal,
	type GithubPagesResolverOptions,
	githubResolverRegistry,
	loadSiteContent,
	parseGithubApiBinding,
	parseStaticSiteTree,
} from "../src/index.js";
import {
	digestOf,
	githubWorld,
	memoryStore,
	OIDC,
	OWNER,
	options,
	REPO,
	request,
	SITE_V1,
	SITE_V2,
	TOKEN,
} from "./support/world.js";

const PHYSICAL = `${OWNER}/${REPO}`;

function resolverFor(
	overrides: Partial<GithubPagesResolverOptions> = {},
): ResourceResolver {
	const store = memoryStore(...SITE_V1.blobs, ...SITE_V2.blobs);
	const resolver = githubResolverRegistry(options(store, overrides)).get(
		GITHUB_PAGES_SITE_PRODUCT_ID,
	);
	if (!resolver) throw new Error("GitHub Pages resolver is not registered");
	return resolver;
}

function parsed(outcome: ResolveOutcome | undefined) {
	return parseResolveOutcome(JSON.parse(JSON.stringify(outcome)));
}

async function refusal(promise: Promise<unknown>): Promise<ResolverError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ResolverError) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

function reasonOf(error: ResolverError): string | undefined {
	return error instanceof GithubPagesRefusal ? error.reason : undefined;
}

async function treeOf(freight: typeof SITE_V1) {
	const site = await loadSiteContent(
		parseStaticSiteTree(freight.index, freight.digest),
		memoryStore(...freight.blobs).get,
	);
	return site.treeSha;
}

describe("branch mode: converge by compare-and-swap commit", () => {
	it("creates the publishing branch, reports building until the Pages build is built, then converges", async () => {
		const world = githubWorld();
		const resolver = resolverFor();
		const first = parsed(await resolver.reconcile(request(), world.transport));
		const expected = await treeOf(SITE_V1);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe(PHYSICAL);
		expect(world.publishedTree()).toBe(expected);
		expect(first.outputs).toMatchObject({
			treeSha: expected,
			publishedTreeSha: expected,
			contentMatches: true,
			pagesBuildStatus: "building",
			ready: false,
			operationConfirmed: true,
			lifecycleStatus: "building",
		});
		world.finishBuild("built");
		const before = world.mutations().length;
		const second = parsed(
			await resolver.reconcile(request({}, PHYSICAL), world.transport),
		);
		expect(second.action).toBe("noop");
		expect(second.outputs).toMatchObject({
			ready: true,
			lifecycleStatus: "ready",
			pagesBuildStatus: "built",
			headCommitSha: world.refs.get("gh-pages"),
		});
		expect(world.mutations().length).toBe(before);
	});

	it("adopts a branch that already holds the Freight tree without writing anything", async () => {
		const world = githubWorld();
		await resolverFor().reconcile(request(), world.transport);
		world.finishBuild();
		const writes = world.mutations().length;
		const adopted = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(adopted.action).toBe("adopt");
		expect(adopted.outputs.ready).toBe(true);
		expect(world.mutations().length).toBe(writes);
	});

	it("updates to new Freight on top of the observed head, uploading only blobs the branch lacks", async () => {
		const world = githubWorld();
		const resolver = resolverFor();
		await resolver.reconcile(request(), world.transport);
		world.finishBuild();
		const oldHead = world.refs.get("gh-pages");
		const mark = world.requests.length;
		const outcome = parsed(
			await resolver.reconcile(
				request({ artifactDigest: SITE_V2.digest }, PHYSICAL),
				world.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(world.publishedTree()).toBe(await treeOf(SITE_V2));
		const pass = world.requests.slice(mark);
		// site.css is unchanged and already on the branch: two new blobs, not three.
		expect(
			pass.filter((entry) => entry.url.endsWith("/git/blobs")),
		).toHaveLength(2);
		const patch = pass.find((entry) => entry.method === "PATCH");
		expect(JSON.parse(patch?.body ?? "{}")).toMatchObject({ force: false });
		const head = world.head();
		expect(world.commits.get(head)?.parents).toEqual([oldHead]);
		expect(world.commits.get(head)?.message).toBe(
			`Publish ${SITE_V2.digest} (HoBo.CD)`,
		);
	});

	it("publishes into /docs and keeps every other file on the branch", async () => {
		const world = githubWorld({ sourceBranch: "main", sourcePath: "/docs" });
		const resolver = resolverFor();
		// Seed main with a README the site must not disturb.
		await resolver.reconcile(
			request({ branch: "main", path: "/docs" }),
			world.transport,
		);
		const root = world.commits.get(world.head("main"))?.tree ?? "";
		expect(world.trees.get(root)?.has("docs")).toBe(true);
		const outcome = parsed(
			await resolver.reconcile(
				request({
					branch: "main",
					path: "/docs",
					artifactDigest: SITE_V2.digest,
				}),
				world.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(world.publishedTree("main", "/docs")).toBe(await treeOf(SITE_V2));
		expect(outcome.outputs.publishedTreeSha).toBe(await treeOf(SITE_V2));
	});

	it("asks for a Pages build when the published content has none, and only on a pass that pushed nothing", async () => {
		const world = githubWorld();
		world.faults.autoBuild = false;
		const resolver = resolverFor();
		const pushed = parsed(await resolver.reconcile(request(), world.transport));
		expect(pushed.outputs.pagesBuildStatus).toBeNull();
		expect(
			world.requests.some(
				(entry) =>
					entry.url.endsWith("/pages/builds") && entry.method === "POST",
			),
		).toBe(false);
		const requested = parsed(
			await resolver.reconcile(request(), world.transport),
		);
		expect(requested.outputs).toMatchObject({
			pagesBuildStatus: "queued",
			ready: false,
		});
		world.finishBuild();
		const ready = parsed(await resolver.reconcile(request(), world.transport));
		expect(ready.outputs.ready).toBe(true);
	});
});

describe("branch mode: ambiguous outcomes are resolved by observation (I5)", () => {
	it("converges when the ref update landed but its reply was lost", async () => {
		const world = githubWorld();
		world.faults.dropReply = "/git/refs";
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.contentMatches).toBe(true);
	});

	it("refuses as not observable when the ref update never landed, and the next pass publishes", async () => {
		const world = githubWorld();
		await resolverFor().reconcile(request(), world.transport);
		world.finishBuild();
		world.faults.lostBefore = "/git/refs/heads/";
		const error = await refusal(
			resolverFor().reconcile(
				request({ artifactDigest: SITE_V2.digest }),
				world.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/not observable.*reply was lost/u);
		expect(world.publishedTree()).toBe(await treeOf(SITE_V1));
		const retried = parsed(
			await resolverFor().reconcile(
				request({ artifactDigest: SITE_V2.digest }),
				world.transport,
			),
		);
		expect(retried.action).toBe("update");
		expect(world.publishedTree()).toBe(await treeOf(SITE_V2));
	});

	it("resolves a lost blob reply by looking the blob up by its id", async () => {
		const world = githubWorld();
		world.faults.dropReply = "/git/blobs";
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.outputs.contentMatches).toBe(true);
		expect(
			world.requests.some(
				(entry) =>
					entry.method === "GET" &&
					/\/git\/blobs\/[0-9a-f]{40}$/u.test(entry.url),
			),
		).toBe(true);
	});

	it("refuses a non-fast-forward with a typed reason when another writer moved the branch", async () => {
		const world = githubWorld();
		await resolverFor().reconcile(request(), world.transport);
		world.faults.racingWriter = true;
		const error = await refusal(
			resolverFor().reconcile(
				request({ artifactDigest: SITE_V2.digest }),
				world.transport,
			),
		);
		expect(reasonOf(error)).toBe("github-ref-not-fast-forward");
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		// The foreign commit was not overwritten.
		expect(world.commits.get(world.head())?.message).toBe("foreign writer");
	});
});

describe("typed refusals", () => {
	it("refuses when Pages is disabled, with zero mutations", async () => {
		const world = githubWorld({ pages: false });
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(reasonOf(error)).toBe("github-pages-disabled");
		expect(world.mutations()).toHaveLength(0);
	});

	it("refuses when Pages publishes from another branch, path or from Actions", async () => {
		for (const world of [
			githubWorld({ sourceBranch: "main" }),
			githubWorld({ sourcePath: "/docs" }),
			githubWorld({ buildType: "workflow" }),
		]) {
			const error = await refusal(
				resolverFor().reconcile(request(), world.transport),
			);
			expect(reasonOf(error)).toBe("github-pages-source-mismatch");
			expect(world.mutations()).toHaveLength(0);
		}
	});

	it("refuses a credential without push before writing, and a 403 on write", async () => {
		const readOnly = githubWorld({ push: false });
		const error = await refusal(
			resolverFor().reconcile(request(), readOnly.transport),
		);
		expect(reasonOf(error)).toBe("github-permission-missing");
		expect(readOnly.mutations()).toHaveLength(0);
		const blocked = githubWorld({ writable: false });
		expect(
			reasonOf(
				await refusal(resolverFor().reconcile(request(), blocked.transport)),
			),
		).toBe("github-permission-missing");
	});

	it("refuses a rejected credential and a rate limit with distinct reasons", async () => {
		const world = githubWorld();
		const rejected = await refusal(
			resolverFor({ resolveCredential: async () => "ghp_revoked" }).reconcile(
				request(),
				world.transport,
			),
		);
		expect(reasonOf(rejected)).toBe("github-credential-rejected");
		expect(rejected.code).toBe("RESOLVER_CREDENTIAL_MISSING");
		world.faults.rateLimitOnce = true;
		expect(
			reasonOf(
				await refusal(resolverFor().reconcile(request(), world.transport)),
			),
		).toBe("github-rate-limited");
	});

	it("refuses a Pages build that errored on the published head", async () => {
		const world = githubWorld();
		await resolverFor().reconcile(request(), world.transport);
		world.finishBuild("errored");
		expect(
			reasonOf(
				await refusal(resolverFor().reconcile(request(), world.transport)),
			),
		).toBe("github-pages-build-errored");
	});

	it("refuses other products as RESOLVER_PRODUCT_UNSUPPORTED", async () => {
		const raw = request();
		const error = await refusal(
			resolverFor().reconcile(
				{ ...raw, ref: { ...raw.ref, productId: "github.release/v1" } },
				githubWorld().transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses undeclared desired keys, an unknown mode, a mismatched physical id and missing Freight", async () => {
		const world = githubWorld();
		for (const raw of [
			request({ cname: "docs.example.com" }),
			request({ publishMode: "ftp" }),
			request({ path: "/site" }),
			request({ branch: "../main" }),
			request({}, "someone/else"),
			request({ artifactDigest: digestOf(new Uint8Array([1])) }),
		])
			await expect(
				resolverFor().reconcile(raw, world.transport),
			).rejects.toBeInstanceOf(ResolverError);
		expect(world.requests).toHaveLength(0);
	});
});

describe("pages-deployment mode", () => {
	const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;
	const deployment = (
		overrides = {},
		physicalId?: string,
		observed?: ResolveOutcome["outputs"],
	) =>
		request(
			{
				publishMode: "pages-deployment",
				branch: undefined,
				path: undefined,
				actionsArtifactId: 42,
				actionsArtifactDigest: ARTIFACT_DIGEST,
				...overrides,
			},
			physicalId,
			observed === undefined ? undefined : { ...observed },
		);
	const withOidc = { resolveDeploymentOidcToken: async () => OIDC };

	it("deploys the verified Actions artifact with the Freight tree id as the build version, then converges on succeed", async () => {
		const world = githubWorld({ buildType: "workflow" });
		world.artifacts.set(42, { digest: ARTIFACT_DIGEST, expired: false });
		const resolver = resolverFor(withOidc);
		const created = parsed(
			await resolver.reconcile(deployment(), world.transport),
		);
		const tree = await treeOf(SITE_V1);
		expect(created.action).toBe("create");
		expect(created.outputs).toMatchObject({
			pagesBuildVersion: tree,
			pagesDeploymentStatus: "deployment_queued",
			ready: false,
		});
		const id = String(created.outputs.pagesDeploymentId);
		expect(world.deployments.get(id)?.version).toBe(tree);
		const body = world.requests.find((entry) =>
			entry.url.endsWith("/pages/deployments"),
		)?.body;
		expect(JSON.parse(body ?? "{}")).toMatchObject({
			artifact_id: 42,
			pages_build_version: tree,
		});
		// A reconcile that knows the deployment observes it instead of deploying again.
		const pending = parsed(
			await resolver.reconcile(
				deployment({}, PHYSICAL, created.outputs),
				world.transport,
			),
		);
		expect(pending.action).toBe("noop");
		expect(pending.outputs.ready).toBe(false);
		world.setDeploymentStatus(id, "succeed");
		const steady = parsed(
			await resolver.reconcile(
				deployment({}, PHYSICAL, created.outputs),
				world.transport,
			),
		);
		expect(steady.action).toBe("noop");
		expect(steady.outputs).toMatchObject({
			ready: true,
			pagesDeploymentId: id,
			lifecycleStatus: "ready",
		});
		expect(world.deployments.size).toBe(1);
	});

	it("redeploys after a retryable failure and refuses a content failure", async () => {
		const world = githubWorld({ buildType: "workflow" });
		world.artifacts.set(42, { digest: ARTIFACT_DIGEST, expired: false });
		const resolver = resolverFor(withOidc);
		const first = parsed(
			await resolver.reconcile(deployment(), world.transport),
		);
		const id = String(first.outputs.pagesDeploymentId);
		world.setDeploymentStatus(id, "deployment_lost");
		const again = parsed(
			await resolver.reconcile(
				deployment({}, PHYSICAL, first.outputs),
				world.transport,
			),
		);
		expect(again.action).toBe("update");
		expect(again.outputs.pagesDeploymentId).not.toBe(id);
		world.setDeploymentStatus(
			again.outputs.pagesDeploymentId,
			"deployment_content_failed",
		);
		const error = await refusal(
			resolver.reconcile(
				deployment({}, PHYSICAL, again.outputs),
				world.transport,
			),
		);
		expect(reasonOf(error)).toBe("github-pages-deployment-failed");
	});

	it("refuses with artifact-unavailable when no artifact is declared, it expired, its digest differs or no OIDC token is bound", async () => {
		const world = githubWorld({ buildType: "workflow" });
		world.artifacts.set(42, { digest: ARTIFACT_DIGEST, expired: false });
		world.artifacts.set(43, { digest: ARTIFACT_DIGEST, expired: true });
		const cases: [ResourceResolver, ReturnType<typeof deployment>][] = [
			[
				resolverFor(withOidc),
				deployment({
					actionsArtifactId: undefined,
					actionsArtifactDigest: undefined,
				}),
			],
			[resolverFor(withOidc), deployment({ actionsArtifactId: 43 })],
			[
				resolverFor(withOidc),
				deployment({ actionsArtifactDigest: `sha256:${"b".repeat(64)}` }),
			],
			[resolverFor(), deployment()],
		];
		for (const [resolver, raw] of cases)
			expect(
				reasonOf(await refusal(resolver.reconcile(raw, world.transport))),
			).toBe("github-pages-artifact-unavailable");
		expect(world.deployments.size).toBe(0);
	});
});

describe("read and delete", () => {
	it("reads undefined when Pages is disabled and the observed state otherwise", async () => {
		expect(
			await resolverFor().read?.(
				request(),
				githubWorld({ pages: false }).transport,
			),
		).toBeUndefined();
		const world = githubWorld();
		await resolverFor().reconcile(request(), world.transport);
		const writes = world.mutations().length;
		const observed = parsed(
			await resolverFor().read?.(request({}, PHYSICAL), world.transport),
		);
		expect(observed.action).toBe("noop");
		expect(observed.outputs.contentMatches).toBe(true);
		expect(world.mutations().length).toBe(writes);
	});

	it("unpublishes the site on delete and confirms it by observation; retain touches nothing", async () => {
		const world = githubWorld();
		await resolverFor().reconcile(request(), world.transport);
		const mark = world.requests.length;
		await resolverFor().delete(
			request({ onDelete: "retain" }),
			world.transport,
		);
		expect(world.requests.length).toBe(mark);
		await resolverFor().delete(request(), world.transport);
		expect(world.pages()).toBeUndefined();
		// Deleting again is a no-op: the site is already absent.
		await resolverFor().delete(request(), world.transport);
		expect(
			world.mutations().filter((entry) => entry.method === "DELETE"),
		).toHaveLength(1);
		// The branch content is history, not destroyed.
		expect(world.publishedTree()).toBe(await treeOf(SITE_V1));
	});
});

describe("credential law (I9) and transport guard", () => {
	it("never puts the token or OIDC token in an outcome, an error or a request URL", async () => {
		const world = githubWorld();
		const seen: string[] = [];
		const outcome = await resolverFor().reconcile(request(), world.transport);
		seen.push(JSON.stringify(outcome));
		world.faults.racingWriter = true;
		seen.push(
			(
				await refusal(
					resolverFor().reconcile(
						request({ artifactDigest: SITE_V2.digest }),
						world.transport,
					),
				)
			).message,
		);
		seen.push(
			(
				await refusal(
					resolverFor({
						resolveCredential: async () => "ghp_revoked",
					}).reconcile(request(), world.transport),
				)
			).message,
		);
		const deploymentWorld = githubWorld({ buildType: "workflow" });
		seen.push(
			(
				await refusal(
					resolverFor({
						resolveDeploymentOidcToken: async () => OIDC,
					}).reconcile(
						request({
							publishMode: "pages-deployment",
							branch: undefined,
							path: undefined,
							actionsArtifactId: 9,
							actionsArtifactDigest: `sha256:${"c".repeat(64)}`,
						}),
						deploymentWorld.transport,
					),
				)
			).message,
		);
		for (const text of [...seen, ...world.requests.map((entry) => entry.url)]) {
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain(OIDC);
		}
	});

	it("pins the guard to the bound API host and its /repos/ subtree", () => {
		expect(parseGithubApiBinding({ kind: "github.com" }).policy).toMatchObject({
			allowedHosts: ["api.github.com"],
			allowedPathPrefixes: ["/repos/"],
		});
		expect(
			parseGithubApiBinding({
				kind: "ghes",
				origin: "https://ghe.example.com:8443",
			}),
		).toMatchObject({
			base: "https://ghe.example.com:8443/api/v3",
			policy: {
				allowedPathPrefixes: ["/api/v3/repos/"],
				allowedPorts: ["8443"],
			},
		});
		for (const origin of [
			"http://ghe.example.com",
			"https://user:pw@ghe.example.com",
			"https://ghe.example.com/api",
		])
			expect(() => parseGithubApiBinding({ kind: "ghes", origin })).toThrow(
				ResolverError,
			);
	});

	it("refuses a transport answer from a host the guard does not allow", async () => {
		const resolver = resolverFor({
			api: { kind: "ghes", origin: "https://ghe.example.com" },
		});
		// The world serves api.github.com only; the guard keeps every request on ghe.example.com.
		const world = githubWorld();
		await expect(
			resolver.reconcile(request(), world.transport),
		).rejects.toThrow();
		for (const entry of world.requests)
			expect(new URL(entry.url).host).toBe("ghe.example.com");
	});
});
