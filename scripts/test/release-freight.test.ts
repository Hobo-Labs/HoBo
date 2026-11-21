import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pipelines } from "../../release/hobo-release.delivery.ts";
import {
	announceVerdict,
	awaitReleasePagesWall,
	classifyRelease,
	githubApiProbeTransport,
	PAGES_RELEASE_VERIFICATION_PROGRESS_MS,
	PAGES_RELEASE_VERIFICATION_WINDOW_MS,
	promoteReleaseFreight,
	RELEASE_DRIVE_PAGES,
	RELEASE_PAGES_WALL_BUDGET_MS_DEFAULT,
	RELEASE_PROMOTION_TIMEOUT,
	type ReleaseCd,
	type ReleaseDriveState,
	type ReleaseHttpTransport,
	releaseCampId,
	releaseDeclaration,
	releaseDriveFor,
	releaseFreightManifest,
	releasePagesWallBudgetMs,
	releaseSource,
	siteTree,
	startReleasePagesWall,
} from "../ci/create-github-release.mts";

type TransportRequest = Parameters<ReleaseHttpTransport>[0];

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

	it("sizes the Pages drive from convergence, verification, and one poll interval", () => {
		const drive = releaseDriveFor("pages");
		expect(drive).toEqual(RELEASE_DRIVE_PAGES);
		expect(RELEASE_DRIVE_PAGES.passes).toBe(572);
		const drivenMs = (drive.passes - 1) * drive.intervalMs;
		expect(drivenMs).toBe(
			PAGES_RELEASE_VERIFICATION_PROGRESS_MS +
				PAGES_RELEASE_VERIFICATION_WINDOW_MS +
				drive.intervalMs,
		);
	});

	it("authenticates GitHub probes and accepts only a built Pages head", async () => {
		const seen: TransportRequest[] = [];
		const build = { status: "building", commit: COMMIT };
		let head = COMMIT;
		const inner = async (request: TransportRequest) => {
			seen.push(request);
			if (request.url.endsWith("/pages/builds/latest"))
				return { status: 200, headers: {}, body: JSON.stringify(build) };
			if (request.url.endsWith("/git/ref/heads/gh-pages"))
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({ object: { sha: head } }),
				};
			return { status: 200, headers: {}, body: "{}" };
		};
		const probe = githubApiProbeTransport(
			{ GITHUB_TOKEN: "release-probe-token" },
			inner,
		);
		const latestBuild = () =>
			probe({
				method: "GET",
				url: "https://api.github.com/repos/Hobo-Labs/HoBo/pages/builds/latest",
				headers: {},
				timeoutMs: 5_000,
				maxResponseBytes: 1_048_576,
			});
		expect((await latestBuild()).status).toBe(404);
		build.status = "built";
		head = "f".repeat(40);
		expect((await latestBuild()).status).toBe(404);
		head = COMMIT;
		expect((await latestBuild()).status).toBe(200);
		await probe({
			method: "GET",
			url: "https://registry.npmjs.org/-/ping",
			headers: {},
			timeoutMs: 5_000,
			maxResponseBytes: 1_048_576,
		});
		expect(seen).toHaveLength(6);
		for (const request of seen.slice(0, 5)) {
			expect(request.headers.authorization).toBe("Bearer release-probe-token");
			expect(request.headers.accept).toBe("application/vnd.github+json");
			expect(request.maxResponseBytes).toBeLessThan(64 * 1024);
		}
		expect(seen[5]?.headers.authorization).toBeUndefined();
	});

	it("keeps Pages build validation when GITHUB_TOKEN is absent", async () => {
		const seen: TransportRequest[] = [];
		const inner = async (request: TransportRequest) => {
			seen.push(request);
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({ status: "building", commit: COMMIT }),
			};
		};
		const probe = githubApiProbeTransport({}, inner);

		const response = await probe({
			method: "GET",
			url: "https://api.github.com/repos/Hobo-Labs/HoBo/pages/builds/latest",
			headers: {},
			timeoutMs: 5_000,
			maxResponseBytes: 1_048_576,
		});

		expect(response.status).toBe(404);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.authorization).toBeUndefined();
		expect(seen[0]?.headers.accept).toBe("application/vnd.github+json");
		expect(seen[0]?.maxResponseBytes).toBeLessThan(64 * 1024);
	});

	it("probes the latest Pages build for every promotion node", () => {
		const pages = pipelines.find(
			(pipeline) => pipeline.name === "hobo-release-pages",
		);
		expect(pages).toBeDefined();
		for (const node of pages?.nodes ?? []) {
			expect(node.verification).toMatchObject({
				windowMs: String(PAGES_RELEASE_VERIFICATION_WINDOW_MS),
				progressDeadlineMs: String(PAGES_RELEASE_VERIFICATION_PROGRESS_MS),
			});
			expect(node.verification.probes[0]).toMatchObject({
				urlRef:
					"https://api.github.com/repos/Hobo-Labs/HoBo/pages/builds/latest",
				expectStatus: 200,
			});
		}
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

describe("Pages wall budget", () => {
	it("defaults to 20 minutes, covers the full drive, and clamps the environment to that maximum", () => {
		expect(RELEASE_PAGES_WALL_BUDGET_MS_DEFAULT).toBe(20 * 60_000);
		expect(RELEASE_PAGES_WALL_BUDGET_MS_DEFAULT).toBeGreaterThan(
			PAGES_RELEASE_VERIFICATION_PROGRESS_MS +
				PAGES_RELEASE_VERIFICATION_WINDOW_MS,
		);
		expect(releasePagesWallBudgetMs({})).toBe(
			RELEASE_PAGES_WALL_BUDGET_MS_DEFAULT,
		);
		expect(
			releasePagesWallBudgetMs({
				HOBO_RELEASE_PAGES_WALL_BUDGET_MS: "36000000",
			}),
		).toBe(RELEASE_PAGES_WALL_BUDGET_MS_DEFAULT);
		expect(
			releasePagesWallBudgetMs({ HOBO_RELEASE_PAGES_WALL_BUDGET_MS: "60000" }),
		).toBe(60_000);
		for (const invalid of ["", "soon", "-1", "0"])
			expect(
				releasePagesWallBudgetMs({
					HOBO_RELEASE_PAGES_WALL_BUDGET_MS: invalid,
				}),
			).toBe(RELEASE_PAGES_WALL_BUDGET_MS_DEFAULT);
		expect(
			startReleasePagesWall(
				{ HOBO_RELEASE_PAGES_WALL_BUDGET_MS: "60000" },
				() => 1_000,
			),
		).toEqual({ deadlineAt: 61_000 });
	});

	it("returns finished work and passes a work failure through untouched", async () => {
		await expect(
			awaitReleasePagesWall("record", async () => "recorded", undefined),
		).resolves.toBe("recorded");
		await expect(
			awaitReleasePagesWall(
				"record",
				async () => {
					throw new Error("freight refused");
				},
				{ deadlineAt: Date.now() + 60_000 },
			),
		).rejects.toThrow("freight refused");
	});

	it("never starts work past the deadline", async () => {
		let started = false;
		await expect(
			awaitReleasePagesWall(
				"record",
				async () => {
					started = true;
					return "recorded";
				},
				{ deadlineAt: Date.now() - 1 },
			),
		).rejects.toThrow(new RegExp(`${RELEASE_PROMOTION_TIMEOUT}: record`));
		expect(started).toBe(false);
	});

	it("rejects a hung call as a typed release-promotion-timeout", async () => {
		const wall = { deadlineAt: Date.now() + 20 };
		const hung = () => new Promise<never>(() => {});
		await expect(
			awaitReleasePagesWall("drive-stable", hung, wall),
		).rejects.toMatchObject({
			name: "ReleasePromotionWallError",
			phase: "drive-stable",
		});
		await expect(
			awaitReleasePagesWall("drive-stable", hung, wall),
		).rejects.toThrow(new RegExp(`${RELEASE_PROMOTION_TIMEOUT}: drive-stable`));
	});

	it("turns a hung Pages drive into a release-promotion-timeout verdict", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const home = mkdtempSync(join(tmpdir(), "hobo-pages-wall-"));
		try {
			const cd: ReleaseCd = {
				home,
				run: async () => ({
					ok: true,
					data: {
						promotion: {
							promotionId: "promo-pages-1",
							state: "PROMOTION_STATE_ROLLING_OUT",
						},
					},
				}),
				drive: async () => new Promise<ReleaseDriveState>(() => {}),
				store: async () => {
					throw new Error("unused");
				},
				declaration: async () => {
					throw new Error("unused");
				},
				close: async () => {},
			};
			const verdict = await promoteReleaseFreight(cd, {
				family: "pages",
				channel: "candidate",
				freightId: "freight-pages-1",
				drive: { passes: 5, intervalMs: 10 },
				wall: { deadlineAt: Date.now() + 40 },
			});
			expect(verdict).toMatchObject({
				outcome: "blocked",
				codes: [RELEASE_PROMOTION_TIMEOUT],
				promotionId: "promo-pages-1",
			});
			expect(verdict.message).toContain("drive-candidate");
			expect(
				error.mock.calls.some((call) =>
					String(call[0]).startsWith(
						"release-pages: promoting freight-pages-1",
					),
				),
			).toBe(true);
		} finally {
			error.mockRestore();
			rmSync(home, { recursive: true, force: true });
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

	// release-npm runs this CLI while it holds the OIDC token that signs npm
	// provenance naming a GitHub-hosted builder, so the CLI is built on the same
	// kind of runner: a self-hosted box never produces code inside that job.
	it("builds the hobo CLI on the GitHub-hosted runner release-npm uses", () => {
		const block = job("release-hobo-cli");
		expect(block).toMatch(/\n {4}runs-on: ubuntu-24\.04\n/u);
		expect(job("release-npm")).toMatch(/\n {4}runs-on: ubuntu-24\.04\n/u);
		expect(block).toContain("uses: jdx/mise-action@");
		expect(block).not.toContain("ci-runner-preflight");
	});

	it("builds the hobo CLI only for a run that publishes or promotes", () => {
		const block = job("release-hobo-cli");
		expect(block).toMatch(
			/needs: \[release-main-train-gate, release-pages-gate\]/u,
		);
		expect(block).toContain(
			"needs.release-main-train-gate.outputs.run == 'true'",
		);
		expect(block).toContain(
			"needs.release-pages-gate.outputs.deploy == 'true'",
		);
		expect(block).not.toMatch(/workflow_run\.conclusion == 'success'/u);
	});

	// The realize proof builds @hobo/hobo; with the affected images in the same
	// job a Turbo cache miss could run release-contract past its limit.
	it("runs the realize proof in its own pull-request job, gated by the PR gate", () => {
		const contract = job("release-contract");
		expect(contract).not.toContain("--filter=@hobo/hobo...");
		expect(contract).not.toContain("release-freight-realize.test.ts");
		const realize = job("release-realize");
		expect(realize).toContain(
			"(needs.route.result == 'success' || needs.route.result == 'failure')",
		);
		before(realize, "name: Turbo cache", "--filter=@hobo/hobo...");
		before(
			realize,
			"--filter=@hobo/hobo...",
			"release-freight-realize.test.ts",
		);
		expect(realize).toContain('HOBO_RELEASE_REALIZE_REQUIRED: "1"');
		const gate = job("release-pr-gate");
		expect(gate).toMatch(/needs: \[[^\]]*\brelease-realize\b[^\]]*\]/u);
		expect(gate).toContain("needs.release-realize.result");
	});

	it("runs and triggers on the release Freight CLI tests", () => {
		const contract = job("release-contract");
		expect(contract).toContain("scripts/test/release-freight-cli.test.ts");
		const filters = workflow.match(
			/- "scripts\/test\/release-freight-cli\.test\.ts"/gu,
		);
		expect(filters?.length).toBe(2);
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

	it("routes OCI image build and Pages publish through the route job", () => {
		for (const name of ["release-oci-build-tag", "release-pages"] as const) {
			const block = job(name);
			expect(block).toMatch(/needs: \[[^\]]*\broute\b[^\]]*\]/u);
		}
		const oci = job("release-oci-build-tag");
		expect(oci).toMatch(
			/contains\(fromJSON\('\["push","workflow_dispatch","merge_group","workflow_run"\]'\), github\.event_name\) && 'hobo-trunk' \|\| 'hobo'/u,
		);
		const pages = job("release-pages");
		expect(pages).toMatch(/needs\.route\.outputs\.tier == 'github'/u);
		expect(pages).toMatch(
			/needs\.route\.outputs\.runner \|\| 'ubuntu-24\.04'/u,
		);
		expect(pages).toMatch(
			/contains\(fromJSON\('\["push","workflow_dispatch","merge_group","workflow_run"\]'\), github\.event_name\) && 'hobo-trunk' \|\| 'hobo'/u,
		);
	});

	it("publishes Pages only through the realizer: no gh-pages push action", () => {
		const block = job("release-pages");
		expect(block).toContain("deploy-site.mts --release-freight site/dist");
		expect(block).not.toContain("peaceiris/actions-gh-pages");
		expect(block).not.toMatch(/git push/u);
	});

	it("bounds the Pages promote step with a wall budget under its step timeout", () => {
		const block = job("release-pages");
		expect(block).toMatch(/\n {8}timeout-minutes: 21\n/u);
		expect(block).toContain('HOBO_RELEASE_PAGES_WALL_BUDGET_MS: "1200000"');
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
