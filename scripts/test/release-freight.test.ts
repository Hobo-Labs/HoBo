import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyPromotion,
	HOBO_CLI_DIST,
	openReleaseCd,
	promoteReleaseFreight,
	RELEASE_GAP_CODES,
	recordReleaseFreight,
	releaseCampId,
	releaseFreightManifest,
	releasePipelineModule,
	releaseSource,
	siteTreeIndex,
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

describe("releasePipelineModule", () => {
	it("chains candidate to stable so stable Freight needs candidate lineage", () => {
		const [pipeline] = releasePipelineModule("npm").pipelines;
		expect(pipeline?.nodes.map((n) => n.name)).toEqual(["candidate", "stable"]);
		expect(pipeline?.nodes[0]?.campIds).toEqual([releaseCampId("candidate")]);
		expect(pipeline?.nodes[1]?.fromNodes).toEqual(["candidate"]);
		expect(pipeline?.nodes[1]?.campIds).toEqual([releaseCampId("stable")]);
	});
});

describe("classifyPromotion", () => {
	const promotion = (state: string, codes: string[]) => ({
		ok: true,
		code: "HOBO_CD_PROMOTION_REQUESTED",
		data: {
			promotion: {
				promotionId: "promo_1",
				state,
				reasons: codes.map((code) => ({ code, message: code })),
			},
		},
	});

	it("qualifies a promoted release", () => {
		expect(
			classifyPromotion(promotion("PROMOTION_STATE_PROMOTED", [])).outcome,
		).toBe("qualified");
	});

	it("reports the missing realizer as a typed gap, never as qualified", () => {
		const verdict = classifyPromotion(
			promotion("PROMOTION_STATE_REJECTED", [
				"promotion-resolve-failed",
				"planning-camp-unknown",
			]),
		);
		expect(verdict.outcome).toBe("gap");
		expect(verdict.codes).toEqual([
			"promotion-resolve-failed",
			"planning-camp-unknown",
		]);
	});

	it("blocks a rejection that is not the known realizer gap", () => {
		const verdict = classifyPromotion(
			promotion("PROMOTION_STATE_REJECTED", [
				"planning-camp-unknown",
				"freight-yanked",
			]),
		);
		expect(verdict.outcome).toBe("blocked");
	});

	it("blocks a promotion that has not finished (fail closed)", () => {
		expect(
			classifyPromotion(promotion("PROMOTION_STATE_QUEUED", [])).outcome,
		).toBe("blocked");
	});

	it("blocks a refused command unless every reason is a gap code", () => {
		const refused = (codes: string[]) => ({
			ok: false,
			code: codes[0] ?? "",
			data: { reasons: codes.map((code) => ({ code, message: code })) },
		});
		expect(classifyPromotion(refused(["pipeline-unknown-camp"])).outcome).toBe(
			"gap",
		);
		expect(classifyPromotion(refused(["lineage-unsatisfied"])).outcome).toBe(
			"blocked",
		);
	});

	it("keeps the gap list to codes @hobo/cd emits for missing topology or realizers", () => {
		expect([...RELEASE_GAP_CODES].sort()).toEqual([
			"compose-realizer-missing",
			"pipeline-unknown-camp",
			"planning-camp-unknown",
			"promotion-resolve-failed",
		]);
	});
});

describe("siteTreeIndex", () => {
	it("is deterministic and moves when any published byte moves", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-site-index-"));
		mkdirSync(join(dir, "media"));
		writeFileSync(join(dir, "index.html"), "<h1>HoBo</h1>");
		writeFileSync(join(dir, "media", "bo.png"), "png");
		const first = siteTreeIndex(dir);
		expect(siteTreeIndex(dir).digest).toBe(first.digest);
		expect(
			JSON.parse(new TextDecoder().decode(first.bytes)).files,
		).toHaveLength(2);
		writeFileSync(join(dir, "media", "bo.png"), "png2");
		expect(siteTreeIndex(dir).digest).not.toBe(first.digest);
	});
});

// The real `hobo deploy` composition (@hobo/hobo dist). Offline: SQLite journal
// and filesystem artifact store under a temp HOBO_HOME, no registry calls.
const hoboBuilt = existsSync(HOBO_CLI_DIST);
if (!hoboBuilt) {
	console.warn(
		`release-freight: skipping hobo deploy integration (no ${HOBO_CLI_DIST}; build @hobo/hobo first)`,
	);
}

describe.skipIf(!hoboBuilt)(
	"release Freight through hobo deploy",
	{ timeout: 60_000 },
	() => {
		async function candidate(home: string, bytes = "tarball") {
			const cd = await openReleaseCd({ home, env: {} });
			try {
				const recorded = await recordReleaseFreight(cd, {
					family: "npm",
					source,
					stored: [
						{
							name: "@hobo-labs/core@0.0.0-alpha.1",
							kind: "ARTIFACT_KIND_PACKAGE",
							mediaType: "application/gzip",
							bytes: new TextEncoder().encode(bytes),
						},
					],
					labels: { "hobo.release/ref": "v0.0.0-alpha.1" },
				});
				const verdict = await promoteReleaseFreight(cd, {
					family: "npm",
					channel: "candidate",
					freightId: recorded.freightId,
				});
				return { recorded, verdict };
			} finally {
				await cd.close();
			}
		}

		it("records verified Freight and reports the candidate realizer gap", async () => {
			const home = mkdtempSync(join(tmpdir(), "hobo-release-cd-"));
			const { recorded, verdict } = await candidate(home);
			expect(recorded.freightId).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(verdict.outcome).toBe("gap");
			expect(verdict.codes).toContain("planning-camp-unknown");
			const report = JSON.parse(
				readFileSync(join(home, "release-freight-npm.json"), "utf8"),
			);
			expect(report.freightId).toBe(recorded.freightId);
			expect(report.channels.candidate.outcome).toBe("gap");
		});

		it("promotes to stable only with candidate lineage in the journal", async () => {
			const home = mkdtempSync(join(tmpdir(), "hobo-release-cd-"));
			const { recorded } = await candidate(home);
			const cd = await openReleaseCd({ home, env: {} });
			try {
				const stable = await promoteReleaseFreight(cd, {
					family: "npm",
					channel: "stable",
					freightId: recorded.freightId,
				});
				expect(stable.outcome).toBe("gap");
				expect(stable.lineage).toBe("candidate-journaled");
			} finally {
				await cd.close();
			}
		});

		it("blocks stable for Freight that never went through candidate", async () => {
			const home = mkdtempSync(join(tmpdir(), "hobo-release-cd-"));
			const cd = await openReleaseCd({ home, env: {} });
			try {
				const recorded = await recordReleaseFreight(cd, {
					family: "npm",
					source,
					stored: [
						{
							name: "@hobo-labs/core@0.0.0-alpha.2",
							kind: "ARTIFACT_KIND_PACKAGE",
							mediaType: "application/gzip",
							bytes: new TextEncoder().encode("other"),
						},
					],
				});
				const stable = await promoteReleaseFreight(cd, {
					family: "npm",
					channel: "stable",
					freightId: recorded.freightId,
				});
				expect(stable.outcome).toBe("blocked");
				expect(stable.codes).toEqual(["release-lineage-missing"]);
			} finally {
				await cd.close();
			}
		});

		it("blocks a registry artifact @hobo/cd cannot verify (no fake Freight)", async () => {
			const home = mkdtempSync(join(tmpdir(), "hobo-release-cd-"));
			const cd = await openReleaseCd({ home, env: {} });
			try {
				await expect(
					recordReleaseFreight(cd, {
						family: "oci",
						source,
						registry: [
							{
								name: "hobo-sdk",
								kind: "ARTIFACT_KIND_OCI_IMAGE",
								digest: DIGEST,
								coordinate: "not a coordinate",
								ecosystem: "oci",
								mediaType: "application/vnd.oci.image.index.v1+json",
							},
						],
					}),
				).rejects.toThrow(
					/artifact-coordinate-invalid|freight-artifacts-unverified/,
				);
			} finally {
				await cd.close();
			}
		});
	},
);

describe("release-hobo.yml publishes only release Freight", () => {
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
		before(block, "--filter=@hobo/hobo...", "push-release-ghcr-images.mts");
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
		before(block, "--filter=@hobo/hobo...", "publish-npm-sdk.mts");
	});

	it("records and promotes the Pages bundle before the gh-pages push", () => {
		before(
			job("release-pages"),
			"deploy-site.mts --release-freight site/dist",
			"peaceiris/actions-gh-pages",
		);
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
		expect(job("release-tag")).toMatch(/permissions:\n\s+contents: write\n/u);
		expect(workflow).not.toMatch(/secrets\.HOBO_RELEASE_CD/u);
	});
});
