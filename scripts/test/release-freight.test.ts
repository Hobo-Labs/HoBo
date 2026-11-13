import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	announceVerdict,
	classifyRelease,
	releaseCampId,
	releaseDeclaration,
	releaseFreightManifest,
	releaseSource,
	siteTree,
} from "../ci/create-github-release.mts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;

const source = releaseSource({
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	HOBO_RELEASE_REVISION: COMMIT,
	GITHUB_REF: "refs/heads/main",
	GITHUB_RUN_ID: "42",
});

describe("releaseFreightManifest", () => {
	it("writes hobo.freight-manifest/v1 for one release family with the release source", () => {
		const manifest = releaseFreightManifest({
			family: "oci",
			declarationHash: DIGEST,
			source,
			artifacts: [
				{
					name: "hobo-sdk",
					kind: "ARTIFACT_KIND_OCI_IMAGE",
					digest: DIGEST,
					coordinate: `ghcr.io/hobo-labs/hobo/hobo-sdk@${DIGEST}`,
					ecosystem: "oci",
					mediaType: "application/vnd.oci.image.index.v1+json",
				},
			],
			labels: { "hobo.release/ref": "v0.0.0-alpha.1" },
		});
		expect(manifest.schemaVersion).toBe("hobo.freight-manifest/v1");
		expect(manifest.bindle).toBe("hobo-release-oci");
		expect(manifest.source).toMatchObject({
			repository: "Hobo-Labs/HoBo",
			commit: COMMIT,
			ciSystem: "github-actions",
			ciRunId: "42",
		});
		expect(manifest.labels["hobo.release/family"]).toBe("oci");
		expect(manifest.artifacts[0]?.coordinate).toContain("@sha256:");
	});

	it("refuses a release source whose commit is not a git sha", () => {
		expect(() =>
			releaseSource({
				GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
				HOBO_RELEASE_REVISION: "main",
			}),
		).toThrow(/commit/);
	});
});

describe("release topology names", () => {
	it("names one candidate and one stable Camp per family in the hobo-release Yard", () => {
		expect(releaseCampId("npm", "candidate")).toBe(
			"hobo-release/npm-candidate",
		);
		expect(releaseCampId("pages", "stable")).toBe("hobo-release/pages-stable");
	});

	it("declares each family as one resource on the product its Camps realize", () => {
		expect(releaseDeclaration("oci").resources.release).toEqual({
			type: "data.v1",
			port: "hobo:oci-registry.image/v1",
		});
		expect(releaseDeclaration("npm").resources.release.port).toBe(
			"hobo:npm.package-version/v1",
		);
		expect(releaseDeclaration("pages").resources.release.port).toBe(
			"hobo:github.pages-site/v1",
		);
	});
});

describe("classifyRelease", () => {
	it("qualifies only a promoted release", () => {
		expect(
			classifyRelease("p", { state: "PROMOTION_STATE_PROMOTED", reasons: [] })
				?.outcome,
		).toBe("qualified");
	});

	it("keeps driving while nothing is decided", () => {
		expect(
			classifyRelease("p", {
				state: "PROMOTION_STATE_ROLLING_OUT",
				reasons: [],
				observed: "RECONCILE_STATUS_CONVERGING",
			}),
		).toBeUndefined();
	});

	it("blocks a named npm provider limit too: there is no fallback publisher", () => {
		for (const code of [
			"npm-provenance-bundle-missing",
			"npm-oidc-scoped-unsupported",
			"catalog-binding-invalid",
			"RESOLVER_PRODUCT_UNSUPPORTED",
		])
			expect(
				classifyRelease("p", {
					state: "PROMOTION_STATE_ROLLING_OUT",
					reasons: [],
					observed: "RECONCILE_STATUS_BLOCKED",
					observedReasons: [{ code, message: "refused" }],
				}),
			).toMatchObject({ outcome: "blocked", codes: [code] });
	});

	it("blocks any other realizer refusal and any terminal failure (fail closed)", () => {
		expect(
			classifyRelease("p", {
				state: "PROMOTION_STATE_ROLLING_OUT",
				reasons: [],
				observed: "RECONCILE_STATUS_BLOCKED",
				observedReasons: [
					{ code: "RESOLVER_PROVIDER_REJECTED", message: "tag held" },
				],
			})?.outcome,
		).toBe("blocked");
		expect(
			classifyRelease("p", {
				state: "PROMOTION_STATE_REJECTED",
				reasons: [{ code: "planning-camp-unknown", message: "" }],
			}),
		).toMatchObject({ outcome: "blocked", codes: ["planning-camp-unknown"] });
	});
});

describe("announceVerdict", () => {
	it("allows only a qualified verdict, for every family", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const blocked = {
			outcome: "blocked" as const,
			codes: ["npm-provenance-bundle-missing"],
			message: "no Sigstore bundle",
		};
		const qualified = { outcome: "qualified" as const, codes: [], message: "" };
		try {
			for (const family of ["npm", "oci", "pages"] as const) {
				expect(announceVerdict(family, "candidate", "f", blocked, {})).toBe(
					false,
				);
				expect(announceVerdict(family, "candidate", "f", qualified, {})).toBe(
					true,
				);
			}
		} finally {
			log.mockRestore();
			error.mockRestore();
		}
	});
});

describe("siteTree", () => {
	it("is the hobo.static-site-tree/v1 index, deterministic, and moves when any published byte moves", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-site-index-"));
		mkdirSync(join(dir, "media"));
		writeFileSync(join(dir, "index.html"), "<h1>HoBo</h1>");
		writeFileSync(join(dir, "media", "bo.png"), "png");
		const first = siteTree(dir);
		expect(siteTree(dir).digest).toBe(first.digest);
		const index = JSON.parse(new TextDecoder().decode(first.index));
		expect(index.contract).toBe("hobo.static-site-tree/v1");
		expect(index.files.map((f: { path: string }) => f.path)).toEqual([
			"index.html",
			"media/bo.png",
		]);
		writeFileSync(join(dir, "media", "bo.png"), "png2");
		expect(siteTree(dir).digest).not.toBe(first.digest);
	});

	it("leaves a staging clone's .git out of the published tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-site-index-"));
		writeFileSync(join(dir, "index.html"), "<h1>HoBo</h1>");
		const before = siteTree(dir).digest;
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/gh-pages");
		expect(siteTree(dir).digest).toBe(before);
	});
});

describe("release-hobo.yml publishes through the release Camps' realizers", () => {
	const workflow = readFileSync(
		join(import.meta.dirname, "..", "..", ".github/workflows/release-hobo.yml"),
		"utf8",
	);
	function job(name: string): string {
		const start = workflow.indexOf(`\n  ${name}:\n`);
		expect(start, name).toBeGreaterThanOrEqual(0);
		const rest = workflow.slice(start + 1);
		const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]+:\n/u);
		return next === -1 ? rest : rest.slice(0, next + 1);
	}
	const before = (block: string, first: string, second: string) => {
		const a = block.indexOf(first);
		const b = block.indexOf(second);
		expect(a, first).toBeGreaterThanOrEqual(0);
		expect(b, second).toBeGreaterThan(a);
	};

	it("records GHCR digests as Freight in the push step and keeps the journal", () => {
		const block = job("release-publish");
		expect(block).toMatch(
			/HOBO_RELEASE_CD_HOME: \$\{\{ runner\.temp \}\}\/hobo-release-cd\/oci/u,
		);
		before(
			block,
			"release-freight-cli.mts restore",
			"push-release-ghcr-images.mts",
		);
		// One image per leg, so one journal per image; promote-stable reads them all.
		expect(block).toContain(
			"name: hobo-release-freight-oci-${{ matrix.image_id }}",
		);
		for (const name of ["release-tag", "release-github"])
			expect(job(name)).toContain("pattern: hobo-release-freight-oci-*");
	});

	it("records npm tarballs before npm publish", () => {
		const block = job("release-npm");
		expect(block).toMatch(
			/HOBO_RELEASE_CD_HOME: \$\{\{ runner\.temp \}\}\/hobo-release-cd\/npm/u,
		);
		before(block, "release-freight-cli.mts restore", "publish-npm-sdk.mts");
	});

	// Every release job that runs `hobo deploy` used to build @hobo/hobo itself,
	// which ran each one past the 20-minute job limit. One job builds it; the
	// others restore that build, bound to its digest and revision.
	const consumers = {
		"release-publish": "push-release-ghcr-images.mts",
		"release-npm": "publish-npm-sdk.mts",
		"release-pages": "deploy-site.mts --release-freight",
		"release-tag": "promote-stable",
		"release-github": "promote-stable",
	} as const;

	it("builds the hobo CLI once, with read-only permissions, and publishes its digest", () => {
		const block = job("release-hobo-cli");
		before(block, "--filter=@hobo/hobo...", "release-freight-cli.mts pack");
		before(block, "release-freight-cli.mts pack", "name: hobo-release-cli");
		expect(block).toContain("digest: ${{ steps.pack.outputs.digest }}");
		expect(block).toMatch(/permissions:\n\s+contents: read\n\s+steps:/u);
		expect(block).not.toMatch(/id-token|packages: write|secrets\./u);
	});

	for (const [name, deploy] of Object.entries(consumers))
		it(`${name} restores that build instead of building the CLI`, () => {
			const block = job(name);
			expect(block).not.toContain("--filter=@hobo/hobo...");
			expect(block).toMatch(/needs: \[[^\]]*\brelease-hobo-cli\b[^\]]*\]/u);
			expect(block).toContain("needs.release-hobo-cli.result == 'success'");
			expect(block).toContain(
				"HOBO_RELEASE_CLI_DIGEST: ${{ needs.release-hobo-cli.outputs.digest }}",
			);
			before(
				block,
				"name: hobo-release-cli",
				"release-freight-cli.mts restore",
			);
			before(block, "release-freight-cli.mts restore", deploy);
		});

	it("publishes npm and GHCR only through hobo deploy promote: no npm publish, no docker push", () => {
		expect(job("release-npm")).not.toMatch(/--provenance|npmPublishArgs/u);
		expect(job("release-publish")).not.toMatch(/docker push/u);
		const npm = readFileSync(
			join(import.meta.dirname, "..", "ci", "publish-npm-sdk.mts"),
			"utf8",
		);
		expect(npm).not.toMatch(/"publish"|npmPublishArgs|--provenance/u);
		const oci = readFileSync(
			join(import.meta.dirname, "..", "ci", "push-release-ghcr-images.mts"),
			"utf8",
		);
		expect(oci).not.toMatch(/"push"|runDockerPushWithRetry/u);
	});

	it("publishes Pages only through the realizer: no gh-pages push action", () => {
		const block = job("release-pages");
		expect(block).toContain("deploy-site.mts --release-freight site/dist");
		expect(block).not.toContain("peaceiris/actions-gh-pages");
		expect(block).not.toMatch(/git push/u);
	});

	it("promotes to stable before the signed tag and the GitHub Release", () => {
		before(job("release-tag"), "promote-stable", "push-release-git-tag.mts");
		before(
			job("release-tag"),
			"promote-stable",
			"create-github-release.mts --tag",
		);
		before(
			job("release-github"),
			"promote-stable",
			"create-github-release.mts --tag",
		);
	});

	it("keeps the release permissions and OIDC flow unchanged", () => {
		expect(job("release-npm")).toMatch(/id-token:\s*write/u);
		expect(job("release-publish")).toMatch(/packages:\s*write/u);
		expect(job("release-pages")).toMatch(
			/permissions:\n\s+contents: write\n\s+pages: write\n\s+id-token: write\n/u,
		);
		expect(job("release-tag")).toMatch(/permissions:\n\s+contents: write\n/u);
		expect(workflow).not.toMatch(/secrets\.HOBO_RELEASE_CD/u);
	});
});
