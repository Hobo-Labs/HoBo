import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson } from "@bufbuild/protobuf";
import {
	createBoundedFetchTransport,
	type JsonValue,
	parseTrafficRoutingProviderProfile,
	resolveTrafficRouting,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	GithubPagesSiteDesiredSchema,
	GithubPagesSiteOutputsSchema,
	StaticSiteTreeSchema,
} from "../src/_generated/provider_github_pb.js";
import {
	GITHUB_PAGES_REFUSAL_REASONS,
	GITHUB_PAGES_SITE_PRODUCT_ID,
	GITHUB_PAGES_TRAFFIC_ROUTING_ABSENT,
	GITHUB_PAGES_TRAFFIC_ROUTING_PROFILE,
	githubResolverRegistry,
	HOBO_PROVIDER_GITHUB_PACKAGE,
} from "../src/index.js";
import {
	githubWorld,
	memoryStore,
	OIDC,
	options,
	request,
	SITE_DEPLOY,
	SITE_V1,
	siteFreight,
} from "./support/world.js";

describe("package surface", () => {
	it("registers exactly the Pages site product under provider github", () => {
		const registry = githubResolverRegistry(options(memoryStore()));
		expect(
			registry.list().map((entry) => [entry.providerId, entry.productId]),
		).toEqual([["github", GITHUB_PAGES_SITE_PRODUCT_ID]]);
		expect(registry.get(GITHUB_PAGES_SITE_PRODUCT_ID)?.directives).toEqual([
			"commitMessage",
			"onDelete",
		]);
		expect(HOBO_PROVIDER_GITHUB_PACKAGE).toBe("@hobo/provider-github");
		// SAFETY: package.json is a checked-in manifest with a name and dependencies.
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { name: string; dependencies: Record<string, string> };
		expect(manifest.name).toBe(HOBO_PROVIDER_GITHUB_PACKAGE);
		// HTTP only through @hobo/core HttpTransport: no SDK. The protobuf
		// runtime backs only the generated data-model descriptors.
		expect(Object.keys(manifest.dependencies).sort()).toEqual([
			"@bufbuild/protobuf",
			"@hobo/core",
		]);
	});
});

describe("protobuf wire view", () => {
	it("decodes the tree index, desired state and observed outputs of real reconciles with the generated schemas", async () => {
		expect(() =>
			fromJson(
				StaticSiteTreeSchema,
				JSON.parse(new TextDecoder().decode(SITE_V1.index)),
			),
		).not.toThrow();
		expect(
			fromJson(
				StaticSiteTreeSchema,
				JSON.parse(new TextDecoder().decode(SITE_DEPLOY.index)),
			).pagesArtifactDigest,
		).toMatch(/^sha256:/u);
		const world = githubWorld();
		const outcome = await githubResolverRegistry(
			options(memoryStore(...SITE_V1.blobs)),
		)
			.get(GITHUB_PAGES_SITE_PRODUCT_ID)
			?.reconcile(request(), world.transport);
		const desired = fromJson(GithubPagesSiteDesiredSchema, request().desired);
		expect(desired.publishMode).toBe("branch");
		const outputs = fromJson(
			GithubPagesSiteOutputsSchema,
			outcome?.outputs ?? {},
		);
		expect(outputs.treeSha).toBe(outcome?.outputs.treeSha);
		expect(outputs.lifecycleStatus).toBe("building");
		// An output key the proto does not declare is a wire break.
		expect(() =>
			fromJson(GithubPagesSiteOutputsSchema, { ...outcome?.outputs, extra: 1 }),
		).toThrow();
	});
});

describe("GitHub Pages traffic routing profile", () => {
	it("is kind other, declares no offering and no fallback, and every offering absent", () => {
		const profile = parseTrafficRoutingProviderProfile(
			JSON.parse(JSON.stringify(GITHUB_PAGES_TRAFFIC_ROUTING_PROFILE)),
		);
		expect(profile.provider).toBe("other");
		expect(profile.offerings).toEqual([]);
		expect(profile.fallbacks).toEqual([]);
		expect(
			new Set(
				GITHUB_PAGES_TRAFFIC_ROUTING_ABSENT.map((entry) => entry.offeringId),
			).size,
		).toBe(17);
		const routed = resolveTrafficRouting([profile], {
			features: ["edge.canary"],
			negotiation: "require",
		});
		expect(routed.kind).toBe("unresolved");
	});
});

const CUE_BIN =
	process.env.HOBO_CUE_BIN ??
	fileURLToPath(new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url));

function cueVet(definition: string, value: JsonValue | undefined): void {
	const directory = mkdtempSync(join(tmpdir(), "provider-github-cue-"));
	try {
		const file = join(directory, "document.json");
		writeFileSync(file, JSON.stringify(value));
		execFileSync(
			CUE_BIN,
			[
				"vet",
				fileURLToPath(
					new URL("../data-models/provider_github.cue", import.meta.url),
				),
				file,
				"-d",
				definition,
			],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(CUE_BIN))(
	"GitHub data models vet real records (skipped: no cue binary; set HOBO_CUE_BIN)",
	() => {
		it("vets the tree index, desired state and observed outputs of real reconciles", async () => {
			cueVet(
				"#StaticSiteTree",
				JSON.parse(new TextDecoder().decode(SITE_V1.index)),
			);
			const exec = siteFreight({ "bin/run.sh": "#!/bin/sh\n" }, ["bin/run.sh"]);
			cueVet(
				"#StaticSiteTree",
				JSON.parse(new TextDecoder().decode(exec.index)),
			);
			expect(() =>
				cueVet("#StaticSiteTree", {
					contract: "hobo.static-site-tree/v1",
					files: [
						{ path: "../x", digest: `sha256:${"0".repeat(64)}`, size: 1 },
					],
				}),
			).toThrow();

			cueVet(
				"#StaticSiteTree",
				JSON.parse(new TextDecoder().decode(SITE_DEPLOY.index)),
			);
			const resolver = githubResolverRegistry(
				options(memoryStore(...SITE_V1.blobs, ...SITE_DEPLOY.blobs), {
					resolveDeploymentOidcToken: async () => OIDC,
				}),
			).get(GITHUB_PAGES_SITE_PRODUCT_ID);
			const world = githubWorld();
			const building = await resolver?.reconcile(request(), world.transport);
			world.finishBuild();
			const ready = await resolver?.reconcile(request(), world.transport);
			cueVet("#GithubPagesSiteDesired", request().desired);
			cueVet("#GithubPagesSiteOutputs", building?.outputs);
			cueVet("#GithubPagesSiteOutputs", ready?.outputs);
			expect(ready?.outputs.ready).toBe(true);
			expect(() =>
				cueVet("#GithubPagesSiteOutputs", {
					...building?.outputs,
					ready: true,
				}),
			).toThrow();
			expect(() =>
				cueVet("#GithubPagesSiteDesired", {
					...request().desired,
					actionsArtifactId: 1,
				}),
			).toThrow();

			const workflow = githubWorld({ buildType: "workflow" });
			workflow.artifacts.set(42, {
				digest: `sha256:${"a".repeat(64)}`,
				expired: false,
			});
			const deploymentRequest = request({
				publishMode: "pages-deployment",
				branch: undefined,
				path: undefined,
				artifactDigest: SITE_DEPLOY.digest,
				actionsArtifactId: 42,
				actionsArtifactDigest: `sha256:${"a".repeat(64)}`,
			});
			const deployed = await resolver?.reconcile(
				deploymentRequest,
				workflow.transport,
			);
			cueVet("#GithubPagesSiteDesired", deploymentRequest.desired);
			cueVet("#GithubPagesSiteOutputs", deployed?.outputs);
			workflow.setDeploymentStatus(
				deployed?.outputs.pagesBuildVersion,
				"succeed",
			);
			const live = await resolver?.reconcile(
				deploymentRequest,
				workflow.transport,
			);
			expect(live?.outputs.ready).toBe(true);
			cueVet("#GithubPagesSiteOutputs", live?.outputs);
			expect(() =>
				cueVet("#GithubPagesSiteOutputs", {
					...live?.outputs,
					pagesLiveBuildVersion: "f".repeat(40),
				}),
			).toThrow();
		});

		it("names every refusal reason the code can raise", () => {
			const cue = readFileSync(
				new URL("../data-models/provider_github.cue", import.meta.url),
				"utf8",
			);
			for (const reason of GITHUB_PAGES_REFUSAL_REASONS)
				expect(cue).toContain(`"${reason}"`);
		});
	},
);

const live = {
	owner: process.env.HOBO_GITHUB_PAGES_LIVE_OWNER,
	repo: process.env.HOBO_GITHUB_PAGES_LIVE_REPO,
	branch: process.env.HOBO_GITHUB_PAGES_LIVE_BRANCH,
	token: process.env.HOBO_GITHUB_PAGES_LIVE_TOKEN,
};
describe.skipIf(!Object.values(live).every(Boolean))(
	"GitHub Pages live lane (read-only; skipped: set HOBO_GITHUB_PAGES_LIVE_OWNER, HOBO_GITHUB_PAGES_LIVE_REPO, HOBO_GITHUB_PAGES_LIVE_BRANCH and HOBO_GITHUB_PAGES_LIVE_TOKEN for a repository whose Pages site publishes from that branch at /)",
	() => {
		it("observes the published site without mutating anything", async () => {
			const outcome = await githubResolverRegistry(
				options(memoryStore(...SITE_V1.blobs), {
					resolveCredential: async () => String(live.token),
				}),
			)
				.get(GITHUB_PAGES_SITE_PRODUCT_ID)
				?.read?.(
					request({
						owner: String(live.owner),
						repo: String(live.repo),
						branch: String(live.branch),
					}),
					async (entry) => {
						if (entry.method !== "GET")
							throw new Error("live lane is read-only");
						return createBoundedFetchTransport({ fetchImpl: globalThis.fetch })(
							entry,
						);
					},
				);
			expect(outcome?.physicalId).toBe(`${live.owner}/${live.repo}`);
			expect(outcome?.outputs.headCommitSha).toMatch(/^[0-9a-f]{40}$/u);
			expect(JSON.stringify(outcome)).not.toContain(String(live.token));
		});
	},
);
