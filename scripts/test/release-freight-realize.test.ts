/**
 * HoBo releases realize through @hobo/cd, offline: the built `hobo` CD
 * composition with release/hobo-release.delivery.ts as its topology (what
 * `--yard` loads), recorded registry and GitHub fixtures behind the
 * HttpTransport, and a CD clock that advances per call so verification
 * windows elapse without waiting. The fixtures are the provider packages' own
 * offline worlds (the distribution-spec registry and the GitHub REST world the
 * resolvers' contract tests run against).
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	HOBO_CLI_DIST,
	openReleaseCd,
	promoteReleaseFreight,
	promoteReleaseStable,
	qualifyReleaseCandidate,
	RELEASE_DELIVERY_MODULE,
	type ReleaseCdSeams,
	recordReleaseFreight,
	releaseCampId,
	releaseReportPath,
	releaseSource,
} from "../ci/create-github-release.mts";
import { qualifySiteRelease } from "../deploy-site.mts";

const ROOT = join(import.meta.dirname, "..", "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GHCR_TOKEN = "ghs_releaseFixtureToken0123456789";
const VERSION = "0.0.0-alpha.7";
const REPOSITORY = "hobo-labs/hobo/hobo-sdk";

// The recorded GitHub world (provider-github test support) serves this site.
const OWNER = "hobo-fixtures";
const REPO = "site";
// The Pages Camp follows the repository the workflow runs in. Set before the
// release topology module first loads.
process.env.GITHUB_REPOSITORY = `${OWNER}/${REPO}`;

const built = existsSync(HOBO_CLI_DIST);
// The release-contract lane builds @hobo/hobo first and sets this: there a
// missing build fails the lane instead of skipping the proof.
if (!built && process.env.HOBO_RELEASE_REALIZE_REQUIRED === "1")
	throw new Error(
		`release-freight-realize: ${HOBO_CLI_DIST} is missing; build @hobo/hobo first`,
	);

// The providers' offline worlds load only when the built packages they import
// exist (the suite skips visibly otherwise).
type Fixtures = Readonly<{
	FakeRegistryWorld: typeof import("../../packages/providers/provider-oci-registry/test/support/fake-registry.ts").FakeRegistryWorld;
	image: typeof import("../../packages/providers/provider-oci-registry/test/support/fixtures.ts").image;
	declareLatin1Transport: typeof import("../../packages/providers/provider-oci-registry/src/byte-transport.ts").declareLatin1Transport;
	githubWorld: typeof import("../../packages/providers/provider-github/test/support/world.ts").githubWorld;
	TOKEN: string;
	npm: typeof import("../../packages/providers/provider-npm/test/support/world.ts");
	signer: typeof import("../../packages/cd/src/provenance/signer.ts");
	sigstore: typeof import("../../packages/cd/test/provenance/sigstore-fixture.ts");
}>;
let fx: Fixtures;
// The core transport types, as the providers' worlds use them.
type HttpTransport = InstanceType<Fixtures["FakeRegistryWorld"]>["transport"];
type TransportRequest = Parameters<HttpTransport>[0];
if (!built)
	console.warn(
		`release-freight-realize: skipping (no ${HOBO_CLI_DIST}; build @hobo/hobo first)`,
	);

/** A CD clock that advances on every read: verification windows elapse at once. */
function clock(): () => number {
	let at = Date.parse("2026-11-12T00:00:00Z");
	return () => (at += 500);
}

function ghcrWorld() {
	return new fx.FakeRegistryWorld("latin1", [
		{
			host: "ghcr.io",
			auth: {
				kind: "bearer",
				realm: "https://ghcr.io/token",
				service: "ghcr.io",
				username: "hobo-release",
				password: GHCR_TOKEN,
				anonymousPull: true,
			},
		},
	]);
}

/** Probes the release pipelines declare, answered as the live targets do. */
function withProbes(
	inner: HttpTransport,
	seen: TransportRequest[],
): HttpTransport {
	return async (request) => {
		seen.push(request);
		if (request.url === "https://ghcr.io/v2/")
			return { status: 401, headers: {}, body: "" };
		if (request.url === "https://registry.npmjs.org/-/ping")
			return { status: 200, headers: {}, body: "{}" };
		if (request.url.startsWith("https://raw.githubusercontent.com/"))
			return { status: 200, headers: {}, body: "<h1>HoBo</h1>" };
		return inner(request);
	};
}

function seams(http: HttpTransport): ReleaseCdSeams {
	return { http, now: clock(), drive: { passes: 40, intervalMs: 0 } };
}

const env = {
	HOBO_RELEASE_REVISION: COMMIT,
	GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
	GITHUB_RUN_ID: "42",
	GITHUB_TOKEN: GHCR_TOKEN,
};

/** Every byte the release journal and artifact store hold, as text. */
function journalText(home: string): string {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.push(readFileSync(path).toString("latin1"));
		}
	};
	walk(home);
	return out.join("\n");
}

describe.skipIf(!built)(
	"HoBo releases realize through @hobo/cd (offline)",
	{ timeout: 120_000 },
	() => {
		beforeAll(async () => {
			const registry = await import(
				"../../packages/providers/provider-oci-registry/test/support/fake-registry.ts"
			);
			const images = await import(
				"../../packages/providers/provider-oci-registry/test/support/fixtures.ts"
			);
			const github = await import(
				"../../packages/providers/provider-github/test/support/world.ts"
			);
			const bytes = await import(
				"../../packages/providers/provider-oci-registry/src/byte-transport.ts"
			);
			expect([github.OWNER, github.REPO]).toEqual([OWNER, REPO]);
			fx = {
				FakeRegistryWorld: registry.FakeRegistryWorld,
				image: images.image,
				declareLatin1Transport: bytes.declareLatin1Transport,
				githubWorld: github.githubWorld,
				TOKEN: github.TOKEN,
				npm: await import(
					"../../packages/providers/provider-npm/test/support/world.ts"
				),
				signer: await import("../../packages/cd/src/provenance/signer.ts"),
				sigstore: await import(
					"../../packages/cd/test/provenance/sigstore-fixture.ts"
				),
			};
		});

		it("loads the release topology through the built binary with --yard", () => {
			const home = mkdtempSync(join(tmpdir(), "hobo-release-yard-"));
			const run = spawnSync(
				process.execPath,
				[
					"--no-warnings",
					join(ROOT, "packages", "hobo", "dist", "bin", "hobo.js"),
					"deploy",
					"camp",
					"list",
					"--yard",
					RELEASE_DELIVERY_MODULE,
					"--json",
				],
				{
					cwd: ROOT,
					encoding: "utf8",
					env: { ...process.env, HOBO_HOME: home },
				},
			);
			expect(run.status, run.stderr).toBe(0);
			const ids = [...run.stdout.matchAll(/hobo-release\/[a-z]+-[a-z]+/gu)].map(
				(m) => m[0],
			);
			for (const family of ["npm", "oci", "pages"] as const)
				for (const channel of ["candidate", "stable"] as const)
					expect(ids).toContain(releaseCampId(family, channel));
			const applied = spawnSync(
				process.execPath,
				[
					"--no-warnings",
					join(ROOT, "packages", "hobo", "dist", "bin", "hobo.js"),
					"deploy",
					"pipeline",
					"apply",
					"--file",
					RELEASE_DELIVERY_MODULE,
					"--json",
				],
				{
					cwd: ROOT,
					encoding: "utf8",
					env: { ...process.env, HOBO_HOME: home },
				},
			);
			expect(applied.status, applied.stderr).toBe(0);
			expect(JSON.parse(applied.stdout).code).toBe("HOBO_CD_PIPELINE_APPLIED");
		});

		it("OCI: candidate realizes the release tag on the recorded digest, stable re-observes it", async () => {
			const world = ghcrWorld();
			const fixture = fx.image({ platform: "amd64", binary: true });
			for (const blob of fixture.blobs)
				world.seedBlob("ghcr.io", REPOSITORY, blob.bytes);
			// What docker push left: the manifest by digest, no release tag yet.
			world.seedManifest(
				"ghcr.io",
				REPOSITORY,
				fixture.text,
				fixture.mediaType,
			);
			const seen: TransportRequest[] = [];
			// Stable runs in jobs whose GITHUB_TOKEN holds no `packages: write`:
			// from then on the token endpoint refuses any push scope outright.
			let pullOnly = false;
			const denied: string[] = [];
			const ghcr: HttpTransport = async (request) => {
				const url = new URL(request.url);
				if (
					pullOnly &&
					url.host === "ghcr.io" &&
					url.pathname === "/token" &&
					url.searchParams.getAll("scope").some((s) => /push/u.test(s))
				) {
					denied.push(request.url);
					return {
						status: 403,
						headers: {},
						body: JSON.stringify({ errors: [{ code: "DENIED" }] }),
					};
				}
				return world.transport(request);
			};
			const fixtures = seams(withProbes(ghcr, seen));
			const home = mkdtempSync(join(tmpdir(), "hobo-release-oci-"));
			const { verdict } = await qualifyReleaseCandidate({
				home,
				family: "oci",
				env,
				seams: fixtures,
				registry: [
					{
						name: "hobo-sdk",
						kind: "ARTIFACT_KIND_OCI_IMAGE",
						digest: fixture.digest,
						coordinate: `ghcr.io/${REPOSITORY}@${fixture.digest}`,
						ecosystem: "oci",
						mediaType: "",
					},
				],
				labels: { "hobo.cd/oci.tags": VERSION },
			});
			expect(verdict.outcome).toBe("qualified");
			// The realizer wrote exactly the release tag, by digest: no blob, no
			// manifest upload (the content is already there), no other tag.
			expect(world.paths("PUT")).toEqual([
				`PUT ghcr.io/v2/${REPOSITORY}/manifests/${VERSION}`,
			]);
			expect(world.repo("ghcr.io", REPOSITORY).tags.get(VERSION)).toBe(
				fixture.digest,
			);
			pullOnly = true;
			expect(await promoteReleaseStable(home, env, fixtures)).toBe(true);
			const report = JSON.parse(
				readFileSync(releaseReportPath(home, "oci"), "utf8"),
			);
			expect(report.channels.stable.outcome).toBe("qualified");
			// Stable observed (resolver read, pull scope): it never asked for push.
			expect(denied).toEqual([]);
			// Stable re-observed; it wrote nothing more.
			expect(world.paths("PUT")).toHaveLength(1);
			// The token reached only the registry's token endpoint, never a record.
			expect(journalText(home)).not.toContain(GHCR_TOKEN);
			expect(seen.some((r) => r.url === "https://ghcr.io/v2/")).toBe(true);
		});

		it("OCI: candidate pushes a built image from the artifact store (config and layers, manifest by digest, tag), stable re-observes", async () => {
			// Nothing in this proof may reach a real network.
			const fetched = vi.fn(async () => {
				throw new Error("the release reached the network");
			});
			vi.stubGlobal("fetch", fetched);
			const world = ghcrWorld();
			const fixture = fx.image({ platform: "amd64", binary: true });
			const [config, layer] = fixture.blobs;
			if (!config || !layer) throw new Error("fixture has no config/layer");
			// The toolchain image's repository already holds the config blob.
			world.seedBlob("ghcr.io", "hobo-labs/hobo/hobo-ci-worker", config.bytes);
			const seen: TransportRequest[] = [];
			const fixtures = seams(
				fx.declareLatin1Transport(withProbes(world.transport, seen)),
			);
			const home = mkdtempSync(join(tmpdir(), "hobo-release-oci-push-"));
			const manifest = new TextEncoder().encode(fixture.text);
			const { verdict } = await qualifyReleaseCandidate({
				home,
				family: "oci",
				env,
				seams: fixtures,
				registry: [
					{
						name: "hobo-sdk",
						kind: "ARTIFACT_KIND_OCI_IMAGE",
						digest: fixture.digest,
						coordinate: `ghcr.io/${REPOSITORY}@${fixture.digest}`,
						ecosystem: "store",
						mediaType: fixture.mediaType,
						sizeBytes: String(manifest.byteLength),
					},
				],
				blobs: [manifest, config.bytes, layer.bytes],
				labels: {
					"hobo.cd/oci.tags": VERSION,
					"hobo.cd/oci.mount-from": "hobo-labs/hobo/hobo-ci-worker",
				},
			});
			expect(verdict.outcome).toBe("qualified");
			const repo = world.repo("ghcr.io", REPOSITORY);
			// The registry computed the digest from the bytes it received: the
			// digest recorded as Freight is the digest GHCR serves.
			expect(repo.manifests.has(fixture.digest)).toBe(true);
			expect(repo.tags.get(VERSION)).toBe(fixture.digest);
			expect(
				Buffer.from(world.hosts.get("ghcr.io")?.blobs.get(layer.digest) ?? []),
			).toEqual(Buffer.from(layer.bytes));
			// Config mounted across repositories, the binary layer uploaded, then
			// the manifest by digest and the release tag.
			const mounts = world.calls.filter(
				(call) => call.method === "POST" && call.url.includes("mount="),
			);
			expect(
				mounts.map((call) => new URL(call.url).searchParams.get("mount")),
			).toContain(config.digest);
			const puts = world.paths("PUT");
			expect(
				puts.filter((path) => path.includes("/blobs/uploads/")),
			).toHaveLength(1);
			expect(puts.filter((path) => path.includes("/manifests/"))).toEqual([
				`PUT ghcr.io/v2/${REPOSITORY}/manifests/${fixture.digest}`,
				`PUT ghcr.io/v2/${REPOSITORY}/manifests/${VERSION}`,
			]);
			expect(fetched).not.toHaveBeenCalled();
			expect(await promoteReleaseStable(home, env, fixtures)).toBe(true);
			expect(world.paths("PUT")).toHaveLength(3);
			expect(journalText(home)).not.toContain(GHCR_TOKEN);
		});

		it("OCI: stable only observes: a drifted target blocks it, and it never asks for push scope", async () => {
			const world = ghcrWorld();
			const fixture = fx.image({ platform: "amd64", binary: false });
			for (const blob of fixture.blobs)
				world.seedBlob("ghcr.io", REPOSITORY, blob.bytes);
			world.seedManifest(
				"ghcr.io",
				REPOSITORY,
				fixture.text,
				fixture.mediaType,
			);
			// GHCR answers a push-scoped token request from a token without
			// `packages: write` (the stable jobs') with 403, not a downgrade.
			let pullOnly = false;
			const pushAsked: string[] = [];
			const ghcr: HttpTransport = async (request) => {
				const url = new URL(request.url);
				if (
					pullOnly &&
					url.pathname === "/token" &&
					url.searchParams.getAll("scope").some((s) => /push/u.test(s))
				) {
					pushAsked.push(request.url);
					return { status: 403, headers: {}, body: "" };
				}
				return world.transport(request);
			};
			const fixtures = seams(withProbes(ghcr, []));
			const home = mkdtempSync(join(tmpdir(), "hobo-release-oci-"));
			const { verdict } = await qualifyReleaseCandidate({
				home,
				family: "oci",
				env,
				seams: fixtures,
				registry: [
					{
						name: "hobo-sdk",
						kind: "ARTIFACT_KIND_OCI_IMAGE",
						digest: fixture.digest,
						coordinate: `ghcr.io/${REPOSITORY}@${fixture.digest}`,
						ecosystem: "oci",
						mediaType: "",
					},
				],
				labels: { "hobo.cd/oci.tags": VERSION },
			});
			expect(verdict.outcome).toBe("qualified");
			const writes = world.paths("PUT").length;
			// Someone deleted the release tag between candidate and stable.
			world.repo("ghcr.io", REPOSITORY).tags.delete(VERSION);
			pullOnly = true;
			expect(
				await promoteReleaseStable(home, env, {
					...fixtures,
					drive: { passes: 6, intervalMs: 0 },
				}),
			).toBe(false);
			// Stable re-read the target and found it drifted: it did not repair
			// it (that is candidate's write), and never asked for push scope.
			expect(pushAsked).toEqual([]);
			expect(world.paths("PUT")).toHaveLength(writes);
		});

		it("OCI: a digest the registry does not hold blocks the release (no fallback)", async () => {
			const world = ghcrWorld();
			const fixture = fx.image({ platform: "arm64", binary: false });
			const home = mkdtempSync(join(tmpdir(), "hobo-release-oci-"));
			const cd = await openReleaseCd({
				home,
				env,
				seams: seams(withProbes(world.transport, [])),
			});
			try {
				await expect(
					recordReleaseFreight(cd, {
						family: "oci",
						source: releaseSource(env),
						registry: [
							{
								name: "hobo-sdk",
								kind: "ARTIFACT_KIND_OCI_IMAGE",
								digest: fixture.digest,
								coordinate: `ghcr.io/${REPOSITORY}@${fixture.digest}`,
								ecosystem: "oci",
								mediaType: "",
							},
						],
					}),
				).rejects.toThrow(/freight record refused/);
			} finally {
				await cd.close();
			}
			expect(world.mutations()).toBe(0);
		});

		it("stable refuses Freight that never qualified at candidate (lineage)", async () => {
			const world = ghcrWorld();
			const fixture = fx.image({ platform: "amd64", binary: false });
			for (const blob of fixture.blobs)
				world.seedBlob("ghcr.io", REPOSITORY, blob.bytes);
			world.seedManifest(
				"ghcr.io",
				REPOSITORY,
				fixture.text,
				fixture.mediaType,
			);
			const home = mkdtempSync(join(tmpdir(), "hobo-release-oci-"));
			const cd = await openReleaseCd({
				home,
				env,
				seams: seams(withProbes(world.transport, [])),
			});
			try {
				const { freightId } = await recordReleaseFreight(cd, {
					family: "oci",
					source: releaseSource(env),
					registry: [
						{
							name: "hobo-sdk",
							kind: "ARTIFACT_KIND_OCI_IMAGE",
							digest: fixture.digest,
							coordinate: `ghcr.io/${REPOSITORY}@${fixture.digest}`,
							ecosystem: "oci",
							mediaType: "",
						},
					],
					labels: { "hobo.cd/oci.tags": VERSION },
				});
				const verdict = await promoteReleaseFreight(cd, {
					family: "oci",
					channel: "stable",
					freightId,
					drive: { passes: 5, intervalMs: 0 },
				});
				expect(verdict.outcome).toBe("blocked");
			} finally {
				await cd.close();
			}
			expect(world.paths("PUT")).toEqual([]);
		});

		it("Pages: candidate publishes the tree to gh-pages as `deploy: <sha>`, stable re-observes it", async () => {
			const world = fx.githubWorld({ sourceBranch: "gh-pages" });
			const github: HttpTransport = async (request) => {
				const response = await world.transport(request);
				// GitHub finishes the Pages build the push started.
				if (request.method !== "GET") world.finishBuild("built");
				return response;
			};
			const dist = mkdtempSync(join(tmpdir(), "hobo-site-dist-"));
			writeFileSync(join(dist, "index.html"), "<h1>HoBo</h1>\n");
			writeFileSync(join(dist, ".nojekyll"), "");
			const home = mkdtempSync(join(tmpdir(), "hobo-release-pages-"));
			await qualifySiteRelease({
				dist,
				home,
				env: { ...env, GITHUB_TOKEN: fx.TOKEN },
				seams: seams(withProbes(github, [])),
			});
			const head = world.commits.get(world.head("gh-pages"));
			expect(head?.message).toBe(`deploy: ${COMMIT}`);
			expect(world.publishedTree()).toBeDefined();
			const report = JSON.parse(
				readFileSync(releaseReportPath(home, "pages"), "utf8"),
			);
			expect(report.channels.candidate.outcome).toBe("qualified");
			expect(report.channels.stable.outcome).toBe("qualified");
			// One branch commit, by compare-and-swap on the observed head.
			expect(
				world
					.mutations()
					.filter((r) => r.method === "POST" && r.url.endsWith("/git/commits")),
			).toHaveLength(1);
			expect(journalText(home)).not.toContain(fx.TOKEN);
		});

		it("npm: candidate publishes the tarball with its signed Sigstore bundle through token auth, stable observes anonymously", async () => {
			const { npm, signer, sigstore } = fx;
			const world = npm.registryWorld({ publicReads: true });
			const seen: TransportRequest[] = [];
			const fixtures = seams(withProbes(world.transport, seen));
			const build = signer.githubActionsBuild({
				GITHUB_SERVER_URL: "https://github.com",
				GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
				GITHUB_REPOSITORY_ID: "1",
				GITHUB_REPOSITORY_OWNER_ID: "2",
				GITHUB_WORKFLOW_REF: `${OWNER}/${REPO}/.github/workflows/release-hobo.yml@refs/heads/main`,
				GITHUB_REF: "refs/heads/main",
				GITHUB_SHA: COMMIT,
				GITHUB_EVENT_NAME: "push",
				GITHUB_RUN_ID: "42",
				GITHUB_RUN_ATTEMPT: "1",
				RUNNER_ENVIRONMENT: "github-hosted",
			});
			const root = sigstore.createTestTrustRoot();
			const signed = await signer.signNpmProvenance(
				{ name: npm.NAME, version: "1.2.3", tarball: npm.TARBALL },
				build,
				async (payload) =>
					sigstore.actionsAttestBundle(root, {
						statement: Buffer.from(payload),
						signedAtMs: Date.parse("2026-11-12T00:00:00Z"),
						san: signer.githubWorkflowIdentity(build),
					}),
			);
			const home = mkdtempSync(join(tmpdir(), "hobo-release-npm-"));
			const { verdict } = await qualifyReleaseCandidate({
				home,
				family: "npm",
				env: { ...env, NPM_TOKEN: npm.TOKEN },
				seams: fixtures,
				stored: [
					{
						name: `${npm.NAME}@1.2.3`,
						kind: "ARTIFACT_KIND_PACKAGE",
						mediaType: "application/gzip",
						bytes: npm.TARBALL,
					},
					{
						name: `${npm.NAME}@1.2.3.sigstore`,
						kind: "ARTIFACT_KIND_STATIC_ASSETS",
						mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
						bytes: signed.bundle,
					},
				],
				labels: { "hobo.cd/npm.dist-tag": "alpha" },
			});
			expect(verdict.outcome).toBe("qualified");
			const published = world.packument();
			expect(published?.["dist-tags"]?.alpha).toBe("1.2.3");
			expect(published?.versions?.["1.2.3"]?.dist.attestations).toBeDefined();
			// The publish carried exactly the signed bundle, with the token.
			const put = world.requests.find(
				(r) => r.method === "PUT" && r.body?.includes("_attachments"),
			);
			expect(put?.headers.authorization).toBe(`Bearer ${npm.TOKEN}`);
			const attachments = JSON.parse(put?.body ?? "{}")._attachments;
			expect(attachments[`${npm.NAME}-1.2.3.sigstore`]?.data).toBe(
				new TextDecoder().decode(signed.bundle),
			);
			// The Freight carries the bundle by digest, next to its tarball.
			const manifest = JSON.parse(
				readFileSync(join(home, "release-freight-npm.manifest.json"), "utf8"),
			);
			expect(manifest.artifacts.map((a: { name: string }) => a.name)).toContain(
				`${npm.NAME}@1.2.3.sigstore`,
			);
			// Stable re-observes the public package without the npm token.
			const before = world.requests.length;
			expect(await promoteReleaseStable(home, env, fixtures)).toBe(true);
			const stableReads = world.requests.slice(before);
			expect(stableReads.length).toBeGreaterThan(0);
			expect(stableReads.every((r) => r.method === "GET")).toBe(true);
			expect(
				stableReads.every((r) => r.headers.authorization === undefined),
			).toBe(true);
			expect(journalText(home)).not.toContain(npm.TOKEN);
		});

		it("npm: a tarball without its Sigstore bundle blocks; nothing reaches the registry and nothing else publishes", async () => {
			const npmCalls: TransportRequest[] = [];
			const http = withProbes(async (request) => {
				npmCalls.push(request);
				return { status: 500, headers: {}, body: "" };
			}, []);
			const home = mkdtempSync(join(tmpdir(), "hobo-release-npm-"));
			await expect(
				qualifyReleaseCandidate({
					home,
					family: "npm",
					env: { ...env, NPM_TOKEN: "npm_fixtureToken" },
					seams: seams(http),
					stored: [
						{
							name: `@hobo-labs/core@${VERSION}`,
							kind: "ARTIFACT_KIND_PACKAGE",
							mediaType: "application/gzip",
							bytes: new TextEncoder().encode("tarball"),
						},
					],
					labels: { "hobo.cd/npm.dist-tag": "alpha" },
				}),
			).rejects.toThrow(/blocked: npm-provenance-bundle-missing/);
			expect(npmCalls).toEqual([]);
		});

		it("npm: a package artifact the Camp cannot bind blocks (catalog-binding-invalid)", async () => {
			const npmCalls: TransportRequest[] = [];
			const http = withProbes(async (request) => {
				npmCalls.push(request);
				return { status: 500, headers: {}, body: "" };
			}, []);
			const home = mkdtempSync(join(tmpdir(), "hobo-release-npm-"));
			await expect(
				qualifyReleaseCandidate({
					home,
					family: "npm",
					env,
					seams: seams(http),
					stored: [
						{
							// Not <package>@<version>: the npm Camp cannot bind it.
							name: "hobo-labs-core.tgz",
							kind: "ARTIFACT_KIND_PACKAGE",
							mediaType: "application/gzip",
							bytes: new TextEncoder().encode("tarball"),
						},
					],
					labels: { "hobo.cd/npm.dist-tag": "alpha" },
				}),
			).rejects.toThrow(/blocked: catalog-binding-invalid/);
			const report = JSON.parse(
				readFileSync(releaseReportPath(home, "npm"), "utf8"),
			);
			expect(report.channels.candidate.outcome).toBe("blocked");
			expect(npmCalls).toEqual([]);
		});
	},
);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("release topology module", () => {
	it("is checked in where --yard and pipeline apply name it", () => {
		expect(existsSync(RELEASE_DELIVERY_MODULE)).toBe(true);
	});
});
