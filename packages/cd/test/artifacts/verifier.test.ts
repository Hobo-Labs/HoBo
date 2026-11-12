// WP3 artifact verifier: store-backed digest checks and the registry digest at
// each coordinate, per ecosystem, against fixtures shaped like the real APIs.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	type ArtifactRef,
	ArtifactRefSchema,
	FreightManifestRecordSchema,
	FreightSubject,
} from "../../src/_generated/cd_pb.js";
import {
	ARTIFACT_REASON,
	createArtifactStore,
	createArtifactVerifier,
} from "../../src/artifacts/index.js";
import { cratesIndexPath } from "../../src/artifacts/registries.js";
import type { ArtifactStore, Digest } from "../../src/ports.js";
import {
	bytesOf,
	context,
	json,
	MemoryEventStore,
	RecordingTelemetry,
	ScriptedTransport,
	T0,
	TENANT,
} from "./fakes.js";

const hex = (algorithm: string, bytes: Uint8Array) =>
	createHash(algorithm).update(bytes).digest("hex");
const b64 = (algorithm: string, bytes: Uint8Array) =>
	createHash(algorithm).update(bytes).digest("base64");
const digestOf = (bytes: Uint8Array) => `sha256:${hex("sha256", bytes)}`;

function artifact(
	fields: Partial<ArtifactRef> &
		Pick<ArtifactRef, "digest" | "coordinate" | "ecosystem">,
): ArtifactRef {
	return create(ArtifactRefSchema, {
		name: "app",
		kind: ArtifactKind.PACKAGE,
		...fields,
	});
}

function manifestOf(...artifacts: ArtifactRef[]) {
	return create(FreightManifestRecordSchema, {
		schemaVersion: "hobo.freight-manifest/v1",
		bindle: "acme/api",
		declarationHash: `sha256:${"d".repeat(64)}`,
		artifacts,
	});
}

function harness() {
	const transport = new ScriptedTransport();
	const telemetry = new RecordingTelemetry();
	const deps = { store: new MemoryEventStore(), tenant: TENANT, now: () => T0 };
	const artifacts: ArtifactStore = createArtifactStore(
		{ backend: "memory" },
		deps,
	);
	const verifier = createArtifactVerifier({
		...deps,
		artifacts,
		http: transport.http,
		telemetry,
	});
	return { transport, telemetry, artifacts, verifier };
}

async function codes(h: ReturnType<typeof harness>, ...items: ArtifactRef[]) {
	const outcome = await h.verifier.verify(manifestOf(...items), context());
	return outcome.ok ? [] : outcome.reasons.map((reason) => reason.code);
}

const TARBALL = bytesOf("package tarball bytes v1.2.3");
const OTHER = bytesOf("a different tarball");

describe("store-backed digest check", () => {
	it("verifies an artifact the store holds and that re-hashes to its digest", async () => {
		const h = harness();
		const ref = await h.artifacts.put(
			TARBALL,
			{
				name: "api.wasm",
				kind: ArtifactKind.WASM_COMPONENT,
				mediaType: "application/wasm",
			},
			context(),
		);
		const outcome = await h.verifier.verify(manifestOf(ref), context());
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.value.artifacts[0]?.digest).toBe(ref.digest);
		expect(h.transport.requests).toEqual([]);
		expect(
			h.telemetry.count("hobo.cd.artifact.verify", {
				ecosystem: "store",
				outcome: "verified",
			}),
		).toBe(1);
	});

	it("fails closed when the store lacks the blob, the blob is corrupt, or sizes disagree", async () => {
		const h = harness();
		const missing = artifact({
			digest: digestOf(OTHER),
			coordinate: `store://memory/${digestOf(OTHER)}`,
			ecosystem: "store",
		});
		expect(await codes(h, missing)).toEqual([ARTIFACT_REASON.missing]);
		const ref = await h.artifacts.put(
			TARBALL,
			{
				name: "api",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/gzip",
			},
			context(),
		);
		expect(
			await codes(h, create(ArtifactRefSchema, { ...ref, sizeBytes: 3n })),
		).toEqual([ARTIFACT_REASON.sizeMismatch]);
		expect(
			await codes(
				h,
				create(ArtifactRefSchema, {
					...ref,
					coordinate: `store://memory/${digestOf(OTHER)}`,
				}),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});

	it("refuses a non-sha256 digest and a coordinate carrying credentials without any network call", async () => {
		const h = harness();
		expect(
			await codes(
				h,
				artifact({
					digest: "md5:abc",
					coordinate: "pkg:npm/left-pad@1.3.0",
					ecosystem: "npm",
				}),
			),
		).toEqual([ARTIFACT_REASON.digestInvalid]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "https://bot:hunter2@files.example.com/app.tgz",
					ecosystem: "http",
				}),
			),
		).toEqual([ARTIFACT_REASON.coordinateInvalid]);
		expect(h.transport.requests).toEqual([]);
	});

	it("accepts a Rail Freight manifest, which carries no artifacts", async () => {
		const h = harness();
		const outcome = await h.verifier.verify(
			create(FreightManifestRecordSchema, {
				...manifestOf(),
				subject: FreightSubject.RAIL,
			}),
			context(),
		);
		expect(outcome.ok).toBe(true);
	});
});

describe("OCI manifest digest", () => {
	const manifestBody = JSON.stringify({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config: { digest: `sha256:${"c".repeat(64)}`, size: 7 },
		layers: [],
	});
	const digest = digestOf(bytesOf(manifestBody));

	function registry(
		h: ReturnType<typeof harness>,
		body: string,
		advertise = digestOf(bytesOf(body)),
	) {
		h.transport
			.route((request) =>
				request.url === `https://ghcr.io/v2/acme/api/manifests/${digest}` &&
				request.headers.authorization === undefined
					? {
							status: 401,
							headers: {
								"www-authenticate":
									'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/api:pull"',
							},
							body: "",
						}
					: undefined,
			)
			.route((request) =>
				request.url.startsWith("https://ghcr.io/token?")
					? json(200, { token: "anon-pull-token" })
					: undefined,
			)
			.route((request) =>
				request.url === `https://ghcr.io/v2/acme/api/manifests/${digest}` &&
				request.headers.authorization === "Bearer anon-pull-token"
					? {
							status: 200,
							headers: { "docker-content-digest": advertise },
							body,
						}
					: undefined,
			);
	}

	it("passes when the registry serves the pinned manifest (anonymous token flow)", async () => {
		const h = harness();
		registry(h, manifestBody);
		expect(
			await codes(
				h,
				artifact({
					digest,
					coordinate: `ghcr.io/acme/api:1.4.0@${digest}`,
					ecosystem: "oci",
					kind: ArtifactKind.OCI_IMAGE,
				}),
			),
		).toEqual([]);
		expect(h.transport.requests[0]?.headers.accept).toContain(
			"application/vnd.oci.image.index.v1+json",
		);
		expect(
			new URL(h.transport.requests[1]?.url ?? "").searchParams.get("scope"),
		).toBe("repository:acme/api:pull");
	});

	it("fails on a manifest that does not hash to the pinned digest", async () => {
		const h = harness();
		registry(h, `${manifestBody} `, digest);
		expect(
			await codes(
				h,
				artifact({
					digest,
					coordinate: `ghcr.io/acme/api@${digest}`,
					ecosystem: "oci",
				}),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});

	it("fails when the coordinate pins a different digest than the manifest names", async () => {
		const h = harness();
		registry(h, manifestBody);
		const other = `sha256:${"e".repeat(64)}`;
		expect(
			await codes(
				h,
				artifact({
					digest: other,
					coordinate: `ghcr.io/acme/api@${digest}`,
					ecosystem: "oci",
				}),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});

	it("refuses a mutable tag-only reference without resolving it", async () => {
		const h = harness();
		expect(
			await codes(
				h,
				artifact({
					digest,
					coordinate: "ghcr.io/acme/api:latest",
					ecosystem: "oci",
				}),
			),
		).toEqual([ARTIFACT_REASON.coordinateMutable]);
		expect(h.transport.requests).toEqual([]);
	});

	it("expands Docker Hub short names", async () => {
		const h = harness();
		h.transport.on(
			"GET",
			`https://registry-1.docker.io/v2/library/nginx/manifests/${digest}`,
			{ body: manifestBody },
		);
		expect(
			await codes(
				h,
				artifact({ digest, coordinate: `nginx@${digest}`, ecosystem: "oci" }),
			),
		).toEqual([]);
	});
});

describe("npm dist.integrity", () => {
	const url = "https://registry.npmjs.org/@acme%2Fapi/1.2.3";
	const coordinate = "pkg:npm/%40acme/api@1.2.3";

	it("passes against sha512 integrity using the store's verified copy", async () => {
		const h = harness();
		await h.artifacts.put(
			TARBALL,
			{
				name: "api",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/gzip",
			},
			context(),
		);
		h.transport.on(
			"GET",
			url,
			json(200, {
				name: "@acme/api",
				version: "1.2.3",
				dist: {
					integrity: `sha512-${b64("sha512", TARBALL)}`,
					shasum: hex("sha1", TARBALL),
				},
			}),
		);
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "npm" }),
			),
		).toEqual([]);
	});

	it("fails when the published integrity is for other bytes", async () => {
		const h = harness();
		await h.artifacts.put(
			TARBALL,
			{
				name: "api",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/gzip",
			},
			context(),
		);
		h.transport.on(
			"GET",
			url,
			json(200, { dist: { integrity: `sha512-${b64("sha512", OTHER)}` } }),
		);
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "npm" }),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});

	it("refuses as incomparable when only sha512 is published and the store has no copy", async () => {
		const h = harness();
		h.transport.on(
			"GET",
			url,
			json(200, { dist: { integrity: `sha512-${b64("sha512", TARBALL)}` } }),
		);
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "npm" }),
			),
		).toEqual([ARTIFACT_REASON.digestIncomparable]);
	});

	it("compares a published sha256 integrity directly", async () => {
		const h = harness();
		h.transport.on(
			"GET",
			url,
			json(200, { dist: { integrity: `sha256-${b64("sha256", TARBALL)}` } }),
		);
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "npm" }),
			),
		).toEqual([]);
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(OTHER), coordinate, ecosystem: "npm" }),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});

	it("refuses a version-less coordinate as mutable", async () => {
		const h = harness();
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:npm/left-pad",
					ecosystem: "npm",
				}),
			),
		).toEqual([ARTIFACT_REASON.coordinateMutable]);
	});
});

describe("PyPI digests.sha256", () => {
	const url = "https://pypi.org/pypi/acme-api/1.2.3/json";
	const coordinate =
		"pkg:pypi/acme-api@1.2.3?file_name=acme_api-1.2.3-py3-none-any.whl";
	const body = (bytes: Uint8Array) =>
		json(200, {
			info: { name: "acme-api" },
			urls: [
				{
					filename: "acme_api-1.2.3.tar.gz",
					digests: { sha256: hex("sha256", OTHER) },
				},
				{
					filename: "acme_api-1.2.3-py3-none-any.whl",
					digests: { sha256: hex("sha256", bytes), md5: "x" },
				},
			],
		});

	it("passes when the named file's sha256 matches", async () => {
		const h = harness();
		h.transport.on("GET", url, body(TARBALL));
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "pypi" }),
			),
		).toEqual([]);
	});

	it("fails on mismatch and on a file the release does not have", async () => {
		const h = harness();
		h.transport.on("GET", url, body(OTHER));
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "pypi" }),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:pypi/acme-api@1.2.3?file_name=nope.whl",
					ecosystem: "pypi",
				}),
			),
		).toEqual([ARTIFACT_REASON.registryNotFound]);
	});
});

describe("NuGet catalog packageHash", () => {
	const leaf =
		"https://api.nuget.org/v3/registration5-semver1/acme.api/1.2.3.json";
	const catalog =
		"https://api.nuget.org/v3/catalog0/data/2026.11.01/acme.api.1.2.3.json";

	function nuget(
		h: ReturnType<typeof harness>,
		bytes: Uint8Array,
		catalogUrl = catalog,
	) {
		h.transport.on(
			"GET",
			leaf,
			json(200, {
				"@id": leaf,
				catalogEntry: catalogUrl,
				packageContent:
					"https://api.nuget.org/v3-flatcontainer/acme.api/1.2.3/acme.api.1.2.3.nupkg",
			}),
		);
		h.transport.on(
			"GET",
			catalogUrl,
			json(200, {
				id: "Acme.Api",
				version: "1.2.3",
				packageHash: b64("sha512", bytes),
				packageHashAlgorithm: "SHA512",
			}),
		);
	}

	it("passes against the SHA512 catalog hash of the stored package", async () => {
		const h = harness();
		await h.artifacts.put(
			TARBALL,
			{
				name: "Acme.Api",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/zip",
			},
			context(),
		);
		nuget(h, TARBALL);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:nuget/Acme.Api@1.2.3",
					ecosystem: "nuget",
				}),
			),
		).toEqual([]);
	});

	it("fails on mismatch and refuses a catalog entry on another host", async () => {
		const h = harness();
		await h.artifacts.put(
			TARBALL,
			{
				name: "Acme.Api",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/zip",
			},
			context(),
		);
		nuget(h, OTHER);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:nuget/Acme.Api@1.2.3",
					ecosystem: "nuget",
				}),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
		const elsewhere = harness();
		await elsewhere.artifacts.put(
			TARBALL,
			{
				name: "Acme.Api",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/zip",
			},
			context(),
		);
		nuget(elsewhere, TARBALL, "https://evil.example.com/catalog.json");
		expect(
			await codes(
				elsewhere,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:nuget/Acme.Api@1.2.3",
					ecosystem: "nuget",
				}),
			),
		).toEqual([ARTIFACT_REASON.registryMalformed]);
		expect(
			elsewhere.transport.requests.map((request) => request.url),
		).not.toContain("https://evil.example.com/catalog.json");
	});
});

describe("Maven .sha256/.sha1", () => {
	const file =
		"https://repo.maven.apache.org/maven2/com/acme/api/1.2.3/api-1.2.3.jar";
	const coordinate = "pkg:maven/com.acme/api@1.2.3?type=jar";

	it("passes against .sha256", async () => {
		const h = harness();
		h.transport.on("GET", `${file}.sha256`, {
			body: `${hex("sha256", TARBALL)}\n`,
		});
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "maven" }),
			),
		).toEqual([]);
	});

	it("falls back to .sha1 through the stored copy, and fails on mismatch", async () => {
		const h = harness();
		await h.artifacts.put(
			TARBALL,
			{
				name: "api.jar",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/java-archive",
			},
			context(),
		);
		h.transport.on("GET", `${file}.sha1`, {
			body: `${hex("sha1", TARBALL)}  api-1.2.3.jar`,
		});
		expect(
			await codes(
				h,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "maven" }),
			),
		).toEqual([]);
		const bad = harness();
		bad.transport.on("GET", `${file}.sha256`, { body: hex("sha256", OTHER) });
		expect(
			await codes(
				bad,
				artifact({ digest: digestOf(TARBALL), coordinate, ecosystem: "maven" }),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});

	it("uses a classifier and an https repository_url override", async () => {
		const h = harness();
		h.transport.on(
			"GET",
			"https://maven.acme.example/releases/com/acme/api/1.2.3/api-1.2.3-linux.jar.sha256",
			{ body: hex("sha256", TARBALL) },
		);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate:
						"pkg:maven/com.acme/api@1.2.3?classifier=linux&repository_url=https%3A%2F%2Fmaven.acme.example%2Freleases",
					ecosystem: "maven",
				}),
			),
		).toEqual([]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate:
						"pkg:maven/com.acme/api@1.2.3?repository_url=http%3A%2F%2Fmaven.acme.example",
					ecosystem: "maven",
				}),
			),
		).toEqual([ARTIFACT_REASON.coordinateInvalid]);
	});
});

describe("crates.io index cksum", () => {
	it("computes the sparse index path", () => {
		expect(cratesIndexPath("a")).toBe("1/a");
		expect(cratesIndexPath("ab")).toBe("2/ab");
		expect(cratesIndexPath("abc")).toBe("3/a/abc");
		expect(cratesIndexPath("Serde")).toBe("se/rd/serde");
	});

	it("passes on the pinned version's cksum and fails on mismatch", async () => {
		const lines = (bytes: Uint8Array) =>
			[
				JSON.stringify({
					name: "serde",
					vers: "1.0.0",
					deps: [],
					cksum: hex("sha256", OTHER),
					features: {},
					yanked: false,
				}),
				JSON.stringify({
					name: "serde",
					vers: "1.0.1",
					deps: [],
					cksum: hex("sha256", bytes),
					features: {},
					yanked: false,
				}),
			].join("\n");
		const h = harness();
		h.transport.on("GET", "https://index.crates.io/se/rd/serde", {
			body: lines(TARBALL),
		});
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:cargo/serde@1.0.1",
					ecosystem: "cargo",
				}),
			),
		).toEqual([]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:cargo/serde@1.0.0",
					ecosystem: "cargo",
				}),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:cargo/serde@9.9.9",
					ecosystem: "cargo",
				}),
			),
		).toEqual([ARTIFACT_REASON.registryNotFound]);
	});
});

describe("RubyGems sha", () => {
	it("passes on the version's sha and fails on mismatch", async () => {
		const h = harness();
		h.transport.on(
			"GET",
			"https://rubygems.org/api/v2/rubygems/rack/versions/3.1.8.json",
			json(200, {
				name: "rack",
				version: "3.1.8",
				sha: hex("sha256", TARBALL),
			}),
		);
		h.transport.on(
			"GET",
			"https://rubygems.org/api/v2/rubygems/nokogiri/versions/1.16.0.json?platform=x86_64-linux",
			json(200, { sha: hex("sha256", OTHER) }),
		);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:gem/rack@3.1.8",
					ecosystem: "rubygems",
				}),
			),
		).toEqual([]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:gem/nokogiri@1.16.0?platform=x86_64-linux",
					ecosystem: "rubygems",
				}),
			),
		).toEqual([ARTIFACT_REASON.digestMismatch]);
	});
});

describe("fail-closed registry behaviour", () => {
	it("never consults a registry for an unregistered ecosystem", async () => {
		const h = harness();
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:hex/phoenix@1.7.0",
					ecosystem: "hex",
				}),
			),
		).toEqual([ARTIFACT_REASON.ecosystemUnsupported]);
		expect(h.transport.requests).toEqual([]);
	});

	it("maps unreachable, erroring and missing registries to typed refusals", async () => {
		const h = harness();
		h.transport.route((request) => {
			if (request.url.includes("/down/")) throw new Error("ECONNREFUSED");
			return request.url.includes("/flaky/")
				? { status: 503, headers: {}, body: "" }
				: undefined;
		});
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:gem/down@1.0.0",
					ecosystem: "rubygems",
				}),
			),
		).toEqual([ARTIFACT_REASON.registryUnavailable]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:gem/flaky@1.0.0",
					ecosystem: "rubygems",
				}),
			),
		).toEqual([ARTIFACT_REASON.registryUnavailable]);
		expect(
			await codes(
				h,
				artifact({
					digest: digestOf(TARBALL),
					coordinate: "pkg:gem/absent@1.0.0",
					ecosystem: "rubygems",
				}),
			),
		).toEqual([ARTIFACT_REASON.registryNotFound]);
	});

	it("git and http artifacts verify only through a stored copy", async () => {
		const h = harness();
		const git = artifact({
			digest: digestOf(TARBALL),
			coordinate:
				"https://git.example.com/acme/api.git@0123456789abcdef0123456789abcdef01234567",
			ecosystem: "git",
			kind: ArtifactKind.SOURCE_TREE,
		});
		expect(await codes(h, git)).toEqual([ARTIFACT_REASON.unverifiable]);
		await h.artifacts.put(
			TARBALL,
			{
				name: "src",
				kind: ArtifactKind.SOURCE_TREE,
				mediaType: "application/x-tar",
			},
			context(),
		);
		expect(await codes(h, git)).toEqual([]);
	});

	it("reports every failing artifact, not just the first", async () => {
		const h = harness();
		const outcome = await h.verifier.verify(
			manifestOf(
				artifact({
					name: "a",
					digest: digestOf(TARBALL),
					coordinate: "pkg:hex/a@1",
					ecosystem: "hex",
				}),
				artifact({
					name: "b",
					digest: digestOf(OTHER),
					coordinate: `store://memory/${digestOf(OTHER)}`,
					ecosystem: "store",
				}),
			),
			context(),
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(
				outcome.reasons.map((reason) => [reason.subject, reason.code]),
			).toEqual([
				["a", ARTIFACT_REASON.ecosystemUnsupported],
				["b", ARTIFACT_REASON.missing],
			]);
			expect(outcome.reasons.every((reason) => reason.remediation !== "")).toBe(
				true,
			);
		}
		expect(
			h.telemetry.count("hobo.cd.artifact.verify", {
				outcome: ARTIFACT_REASON.missing,
			}),
		).toBe(1);
	});
});

export type { Digest };
