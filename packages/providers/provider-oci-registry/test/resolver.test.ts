/**
 * oci-registry.image/v1 realizer, red/green against the recorded offline
 * registry world (test/support/fake-registry.ts, whose request vocabulary is
 * the distribution pact). Live registries run only in the credential-gated
 * lane at the bottom, which skips visibly.
 */
import {
	type HttpTransport,
	type ResolveRequest,
	ResolverError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	type OciRegistryCredential,
	type OciRegistryResolverOptions,
	ociRegistryResolverRegistry,
	type ResolverMetricPoint,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	type FakeHostConfig,
	FakeRegistryWorld,
} from "./support/fake-registry.js";
import {
	attestation,
	type ImageFixture,
	image,
	index,
} from "./support/fixtures.js";

const TARGET = "registry.target.test";
const SOURCE = "registry.source.test";
const STORAGE = "storage.source.test";
const TARGET_REALM = "https://auth.target.test/token";
const SOURCE_REALM = "https://auth.source.test/token";
const PASSWORD = "fixture-push-password-do-not-leak";
const SOURCE_PASSWORD = "fixture-pull-password-do-not-leak";

function targetConfig(extra: Partial<FakeHostConfig> = {}): FakeHostConfig {
	return {
		host: TARGET,
		auth: {
			kind: "bearer",
			realm: TARGET_REALM,
			service: TARGET,
			username: "robot",
			password: PASSWORD,
		},
		...extra,
	};
}
function sourceConfig(extra: Partial<FakeHostConfig> = {}): FakeHostConfig {
	return {
		host: SOURCE,
		auth: {
			kind: "bearer",
			realm: SOURCE_REALM,
			service: SOURCE,
			username: "puller",
			password: SOURCE_PASSWORD,
			tokenField: "access_token",
		},
		...extra,
	};
}

function seedImage(
	world: FakeRegistryWorld,
	host: string,
	repo: string,
	fixture: ImageFixture,
	tags: readonly string[] = [],
) {
	for (const blob of fixture.blobs) world.seedBlob(host, repo, blob.bytes);
	world.seedManifest(host, repo, fixture.text, fixture.mediaType, tags);
}

const credentials = {
	"vault://oci/target": {
		kind: "basic",
		username: "robot",
		password: PASSWORD,
	},
	"vault://oci/source": {
		kind: "basic",
		username: "puller",
		password: SOURCE_PASSWORD,
	},
} satisfies Readonly<Record<string, OciRegistryCredential>>;

function registryOf(options: Partial<OciRegistryResolverOptions> = {}) {
	return ociRegistryResolverRegistry({
		registry: { host: TARGET, authRealms: [TARGET_REALM] },
		sourceRegistries: [
			{
				host: SOURCE,
				authRealms: [SOURCE_REALM],
				blobRedirectHosts: [STORAGE],
				credentialRef: "vault://oci/source",
			},
		],
		resolveCredential: async (ref) => {
			const found = new Map<string, OciRegistryCredential>(
				Object.entries(credentials),
			).get(ref);
			if (!found) throw new Error("unknown locator");
			return found;
		},
		transportBodyEncoding: "latin1",
		...options,
	});
}
function resolverOf(options: Partial<OciRegistryResolverOptions> = {}) {
	const found = registryOf(options).get(OCI_REGISTRY_IMAGE_PRODUCT_ID);
	if (!found) throw new Error("oci-registry.image/v1 is not registered");
	return found;
}

function request(
	fixture: ImageFixture,
	desired: Readonly<Record<string, JsonValue | undefined>> = {},
	physicalId?: string,
): ResolveRequest {
	const ref = {
		slot: "service" as const,
		productId: OCI_REGISTRY_IMAGE_PRODUCT_ID,
		logicalId: "app-image",
	};
	return JSON.parse(
		JSON.stringify({
			ref: physicalId === undefined ? ref : { ...ref, physicalId },
			desired: {
				registry: TARGET,
				repository: "team/app",
				digest: fixture.digest,
				tags: ["prod"],
				sourceRegistry: SOURCE,
				sourceRepository: "ci/app",
				...desired,
			},
			credentialRef: "vault://oci/target",
		}),
	);
}

async function rejection(
	promise: Promise<unknown> | undefined,
): Promise<ResolverError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ResolverError) return error;
		throw error;
	}
	throw new Error("expected a ResolverError");
}

function world(
	encoding: "utf-8" | "latin1" = "latin1",
	target: Partial<FakeHostConfig> = {},
	source: Partial<FakeHostConfig> = {},
) {
	return new FakeRegistryWorld(encoding, [
		targetConfig(target),
		sourceConfig(source),
	]);
}

describe("converge: copy from a source registry", () => {
	it("uploads every blob, PUTs the manifest by digest, then the declared tag; digest unchanged", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(`${TARGET}/team/app@${fixture.digest}`);
		expect(outcome.outputs).toMatchObject({
			digest: fixture.digest,
			artifactDigest: fixture.digest,
			manifestPresent: true,
			tagsConverged: true,
			ready: true,
			lifecycleStatus: "ready",
			tagDigests: [{ tag: "prod", digest: fixture.digest }],
		});
		const stored = w.repo(TARGET, "team/app");
		expect(stored.manifests.get(fixture.digest)?.text).toBe(fixture.text);
		expect(stored.tags.get("prod")).toBe(fixture.digest);
		const puts = w.paths("PUT");
		const manifestPut = puts.indexOf(
			`PUT ${TARGET}/v2/team/app/manifests/${fixture.digest}`,
		);
		const tagPut = puts.indexOf(`PUT ${TARGET}/v2/team/app/manifests/prod`);
		expect(manifestPut).toBeGreaterThan(-1);
		expect(tagPut).toBeGreaterThan(manifestPut);
		expect(outcome.diagnostics[0]).toMatch(/uploaded 2/u);
	});

	it("is idempotent by digest: a second reconcile writes nothing and repeats its outcome shape", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		const resolver = resolverOf();
		await resolver.reconcile(request(fixture), w.transport);
		const before = w.mutations();
		const second = await resolver.reconcile(request(fixture), w.transport);
		expect(w.mutations()).toBe(before);
		expect(second.action).toBe("adopt");
		expect(second.diagnostics).toEqual([]);
		const pinned = await resolver.reconcile(
			request(fixture, {}, second.physicalId),
			w.transport,
		);
		expect(pinned.action).toBe("noop");
		expect(w.mutations()).toBe(before);
	});

	it("runs the WWW-Authenticate bearer flow against the allowlisted realm with scoped tokens", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		await resolverOf().reconcile(request(fixture), w.transport);
		const tokenCalls = w.calls.filter((call) =>
			call.url.startsWith(TARGET_REALM),
		);
		expect(tokenCalls.length).toBeGreaterThan(0);
		for (const call of tokenCalls) {
			const url = new URL(call.url);
			expect(url.searchParams.get("service")).toBe(TARGET);
			expect(url.searchParams.getAll("scope")).toContain(
				"repository:team/app:pull,push",
			);
			expect(call.headers.authorization).toMatch(/^Basic /u);
		}
		const sourceTokens = w.calls.filter((call) =>
			call.url.startsWith(SOURCE_REALM),
		);
		expect(sourceTokens.length).toBeGreaterThan(0);
		for (const call of w.calls.filter(
			(c) => new URL(c.url).hostname === TARGET,
		))
			if (call.headers.authorization)
				expect(call.headers.authorization).toMatch(
					/^Bearer fixture-registry-token-/u,
				);
	});

	it("mounts across repositories on the same registry instead of moving bytes", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, TARGET, "team/build", fixture);
		const outcome = await resolverOf().reconcile(
			request(fixture, {
				sourceRegistry: TARGET,
				sourceRepository: "team/build",
			}),
			w.transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.diagnostics[0]).toMatch(/mounted 2, uploaded 0/u);
		expect(w.paths("GET").filter((path) => path.includes("/blobs/"))).toEqual(
			[],
		);
		const mounts = w.calls.filter(
			(call) => call.method === "POST" && call.url.includes("mount="),
		);
		// One mount per blob; the first may be re-sent once after a token exchange.
		expect(
			new Set(mounts.map((call) => new URL(call.url).searchParams.get("mount")))
				.size,
		).toBe(2);
		expect(new URL(mounts[0]?.url ?? "").searchParams.get("from")).toBe(
			"team/build",
		);
	});

	it("falls back to upload through the session a declined mount opened", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world("latin1", { mount: false });
		seedImage(w, TARGET, "team/build", fixture);
		const outcome = await resolverOf().reconcile(
			request(fixture, {
				sourceRegistry: TARGET,
				sourceRepository: "team/build",
			}),
			w.transport,
		);
		expect(outcome.diagnostics[0]).toMatch(/mounted 0, uploaded 2/u);
		// Mount POST returned 202; the bytes went to that session, not a new one.
		const starts = w.calls.filter((call) => call.method === "POST");
		expect(starts.every((call) => call.url.includes("mount="))).toBe(true);
	});

	it("skips blobs the target already holds", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		for (const blob of fixture.blobs)
			w.seedBlob(TARGET, "team/app", blob.bytes);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.diagnostics[0]).toMatch(
			/blobs present 2, mounted 0, uploaded 0/u,
		);
	});

	it("uploads in chunks with Content-Range past chunkBytes", async () => {
		const fixture = image({ platform: "amd64", binary: true, size: 2500 });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		await resolverOf({ chunkBytes: 1000 }).reconcile(
			request(fixture),
			w.transport,
		);
		const patches = w.calls.filter((call) => call.method === "PATCH");
		expect(patches.map((call) => call.headers["content-range"])).toEqual([
			"0-999",
			"1000-1999",
			"2000-2499",
		]);
		expect(
			w.repo(TARGET, "team/app").blobs.has(fixture.blobs[1]?.digest ?? ""),
		).toBe(true);
	});

	it("copies an index: every child manifest and its blobs before the index itself", async () => {
		const amd = image({ platform: "amd64", binary: true });
		const arm = image({ platform: "arm64", binary: true });
		const fixture = index([amd, arm]);
		const w = world();
		seedImage(w, SOURCE, "ci/app", amd);
		seedImage(w, SOURCE, "ci/app", arm);
		seedImage(w, SOURCE, "ci/app", fixture);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.action).toBe("create");
		const puts = w
			.paths("PUT")
			.filter((path) => path.includes("/manifests/sha256:"));
		expect(puts).toEqual([
			`PUT ${TARGET}/v2/team/app/manifests/${amd.digest}`,
			`PUT ${TARGET}/v2/team/app/manifests/${arm.digest}`,
			`PUT ${TARGET}/v2/team/app/manifests/${fixture.digest}`,
		]);
		expect(w.repo(TARGET, "team/app").manifests.get(fixture.digest)?.text).toBe(
			fixture.text,
		);
	});

	it("follows a blob redirect once, to an allowlisted storage host, without the registry credential", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world("latin1", {}, { blobRedirectTo: STORAGE });
		seedImage(w, SOURCE, "ci/app", fixture);
		await resolverOf().reconcile(request(fixture), w.transport);
		const storage = w.calls.filter(
			(call) => new URL(call.url).hostname === STORAGE,
		);
		expect(storage).toHaveLength(2);
		for (const call of storage)
			expect(call.headers.authorization).toBeUndefined();
	});

	it("refuses a blob redirect to a host that is not allowlisted", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world("latin1", {}, { blobRedirectTo: "cdn.elsewhere.test" });
		seedImage(w, SOURCE, "ci/app", fixture);
		const error = await rejection(
			resolverOf().reconcile(request(fixture), w.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(
			/not an allowlisted blob host.*Remediation:/u,
		);
		expect(
			w.calls.some((call) => call.url.includes("cdn.elsewhere.test")),
		).toBe(false);
	});

	it("copies from the host artifact store by digest when no source registry is named", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		const store = new Map<string, Uint8Array>([
			[fixture.digest, Buffer.from(fixture.text, "utf8")],
		]);
		for (const blob of fixture.blobs) store.set(blob.digest, blob.bytes);
		const outcome = await resolverOf({
			artifactStore: { get: async (digest) => store.get(digest) },
		}).reconcile(
			request(fixture, {
				sourceRegistry: undefined,
				sourceRepository: undefined,
			}),
			w.transport,
		);
		expect(outcome.action).toBe("create");
		expect(w.calls.some((call) => new URL(call.url).hostname === SOURCE)).toBe(
			false,
		);
	});

	it("falls back to hashing a GET when a registry omits Docker-Content-Digest", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world("latin1", { omitDigestHeader: true });
		seedImage(w, SOURCE, "ci/app", fixture);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.outputs.tagDigests).toEqual([
			{ tag: "prod", digest: fixture.digest },
		]);
	});
});

describe("converge: body encoding honesty", () => {
	it("refuses to move a binary layer through a UTF-8 text transport, with a remediation, and writes no manifest", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world("utf-8");
		seedImage(w, SOURCE, "ci/app", fixture);
		const error = await rejection(
			resolverOf({ transportBodyEncoding: "utf-8" }).reconcile(
				request(fixture),
				w.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(
			/UTF-8 text transport.*Remediation:|Remediation:.*(mount|latin1)/u,
		);
		expect(w.paths("PUT").some((path) => path.includes("/manifests/"))).toBe(
			false,
		);
	});

	it("moves text-only blobs through the stock UTF-8 transport monolithically", async () => {
		const fixture = image({ platform: "amd64", binary: false });
		const w = world("utf-8");
		seedImage(w, SOURCE, "ci/app", fixture);
		const outcome = await resolverOf({
			transportBodyEncoding: "utf-8",
		}).reconcile(request(fixture), w.transport);
		expect(outcome.action).toBe("create");
		expect(w.calls.some((call) => call.method === "PATCH")).toBe(false);
	});

	it("refuses a chunked upload over a UTF-8 transport rather than split a code point", async () => {
		const fixture = image({ platform: "amd64", binary: false, size: 3000 });
		const w = world("utf-8");
		seedImage(w, SOURCE, "ci/app", fixture);
		const error = await rejection(
			resolverOf({ transportBodyEncoding: "utf-8", chunkBytes: 500 }).reconcile(
				request(fixture),
				w.transport,
			),
		);
		expect(error.message).toMatch(/chunked upload/u);
	});
});

describe("converge: tags", () => {
	it("moves a declared tag to the digest and never touches a tag the desired state does not name", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const old = image({ platform: "old", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		seedImage(w, TARGET, "team/app", old, ["prod", "keep"]);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.action).toBe("create");
		const tags = w.repo(TARGET, "team/app").tags;
		expect(tags.get("prod")).toBe(fixture.digest);
		expect(tags.get("keep")).toBe(old.digest);
		expect(w.paths("PUT")).not.toContain(
			`PUT ${TARGET}/v2/team/app/manifests/keep`,
		);
		expect(w.paths("DELETE")).toEqual([]);
	});

	it("reports update when only a declared tag moved", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, TARGET, "team/app", fixture);
		const outcome = await resolverOf().reconcile(
			request(fixture, { tags: ["prod", "v1.2.3"] }),
			w.transport,
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.tagDigests).toEqual([
			{ tag: "prod", digest: fixture.digest },
			{ tag: "v1.2.3", digest: fixture.digest },
		]);
	});
});

describe("converge: referrers", () => {
	it("copies attestations through the referrers API and confirms they are discoverable at the target", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const att = attestation(fixture);
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		seedImage(w, SOURCE, "ci/app", att);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.outputs.referrers).toEqual([att.digest]);
		expect(outcome.outputs.referrersDiscoverable).toBe(true);
		expect(w.repo(TARGET, "team/app").manifests.get(att.digest)?.text).toBe(
			att.text,
		);
		const again = await resolverOf().reconcile(request(fixture), w.transport);
		expect(again.outputs.referrers).toEqual([att.digest]);
	});

	it("uses the tag-schema fallback index when the source lacks the referrers API, and reports a target that lacks it", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const att = attestation(fixture);
		const w = world("latin1", { referrersApi: false }, { referrersApi: false });
		seedImage(w, SOURCE, "ci/app", fixture);
		seedImage(w, SOURCE, "ci/app", att);
		const fallback = JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.index.v1+json",
			manifests: [
				{
					mediaType: att.mediaType,
					digest: att.digest,
					size: Buffer.byteLength(att.text),
				},
			],
		});
		w.seedManifest(
			SOURCE,
			"ci/app",
			fallback,
			"application/vnd.oci.image.index.v1+json",
			[fixture.digest.replace(":", "-")],
		);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.outputs.referrers).toEqual([att.digest]);
		expect(outcome.outputs.referrersDiscoverable).toBe(false);
		expect(outcome.diagnostics.join(" ")).toMatch(/referrers API/u);
	});

	it("does not copy referrers when the copyReferrers directive is false", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const att = attestation(fixture);
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		seedImage(w, SOURCE, "ci/app", att);
		const outcome = await resolverOf().reconcile(
			request(fixture, { copyReferrers: false }),
			w.transport,
		);
		expect(outcome.outputs.referrers).toBeUndefined();
		expect(w.repo(TARGET, "team/app").manifests.has(att.digest)).toBe(false);
	});
});

describe("ambiguous outcomes are resolved by observation (I5)", () => {
	it("a lost reply to a manifest PUT that landed is observed and accepted", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		w.faults.push({
			match: (call) =>
				call.method === "PUT" &&
				call.url.includes(`/manifests/${fixture.digest}`) &&
				call.headers.authorization !== undefined,
			mode: "apply-then-lose",
		});
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.outputs.ready).toBe(true);
	});

	it("a lost write that did not land is refused, and the next reconcile converges", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		w.faults.push({
			match: (call) =>
				call.method === "PUT" &&
				call.url.includes("/manifests/prod") &&
				call.headers.authorization !== undefined,
			mode: "lose",
		});
		const error = await rejection(
			resolverOf().reconcile(request(fixture), w.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/not observed/u);
		const retry = await resolverOf().reconcile(request(fixture), w.transport);
		expect(retry.outputs.ready).toBe(true);
	});

	it("a transport failure on a read is a typed refusal, never a success", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const failing: HttpTransport = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const error = await rejection(
			resolverOf().reconcile(request(fixture), failing),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

describe("authentication and credential law (I9)", () => {
	it("refuses a token realm that is not allowlisted and never sends the credential there", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = new FakeRegistryWorld("latin1", [
			targetConfig({
				auth: {
					kind: "bearer",
					realm: "https://evil.attacker.test/token",
					service: TARGET,
					username: "robot",
					password: PASSWORD,
				},
			}),
			sourceConfig(),
		]);
		const error = await rejection(
			resolverOf().reconcile(request(fixture), w.transport),
		);
		expect(error.message).toMatch(/not allowlisted.*Remediation:/u);
		expect(w.calls.some((call) => call.url.includes("attacker"))).toBe(false);
	});

	it("answers a Basic challenge (ECR style) with the basic credential", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = new FakeRegistryWorld("latin1", [
			{
				host: TARGET,
				auth: { kind: "basic", username: "robot", password: PASSWORD },
			},
			sourceConfig(),
		]);
		seedImage(w, SOURCE, "ci/app", fixture);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		expect(outcome.outputs.ready).toBe(true);
	});

	it("uses a pre-minted bearer token directly and refuses when the registry rejects it", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = new FakeRegistryWorld("latin1", [
			{ host: TARGET, auth: { kind: "preminted", token: "other-token" } },
			sourceConfig(),
		]);
		const error = await rejection(
			resolverOf({
				resolveCredential: async () => ({
					kind: "bearer",
					token: "fixture-preminted-token",
				}),
			}).reconcile(request(fixture), w.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).not.toContain("fixture-preminted-token");
	});

	it("refuses malformed credential material as RESOLVER_CREDENTIAL_MISSING", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const error = await rejection(
			resolverOf({
				resolveCredential: async () => ({
					kind: "basic",
					username: "robot",
					password: "",
				}),
			}).reconcile(request(fixture), world().transport),
		);
		expect(error.code).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("never leaks credential or token material into outcomes or errors", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		const outcome = await resolverOf().reconcile(request(fixture), w.transport);
		const failure = await rejection(
			resolverOf().reconcile(
				request(fixture, { digest: `sha256:${"e".repeat(64)}` }),
				w.transport,
			),
		);
		const text = JSON.stringify(outcome) + failure.message;
		for (const secret of [PASSWORD, SOURCE_PASSWORD, "fixture-registry-token"])
			expect(text).not.toContain(secret);
	});
});

describe("desired-state refusals (typed, before any call)", () => {
	const fixture = image({ platform: "amd64", binary: true });
	const cases: [
		string,
		Readonly<Record<string, JsonValue | undefined>>,
		RegExp,
	][] = [
		[
			"a registry other than the bound one",
			{ registry: "registry.other.test" },
			/bound/u,
		],
		["a tag instead of a digest", { digest: "latest" }, /sha256 digest/u],
		[
			"a parameter it does not implement",
			{ platform: "linux/amd64" },
			/desired\.platform/u,
		],
		[
			"the referrers fallback tag",
			{ tags: [fixture.digest.replace(":", "-")] },
			/referrers fallback tag/u,
		],
		["a duplicate tag", { tags: ["prod", "prod"] }, /twice/u],
		[
			"an unbound source registry",
			{ sourceRegistry: "registry.unknown.test" },
			/not one the host bound/u,
		],
		[
			"a source without a repository",
			{ sourceRepository: undefined },
			/go together/u,
		],
		["an invalid repository", { repository: "Team/App" }, /repository name/u],
	];
	for (const [name, desired, pattern] of cases)
		it(`refuses ${name}`, async () => {
			const w = world();
			const error = await rejection(
				resolverOf().reconcile(request(fixture, desired), w.transport),
			);
			expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
			expect(error.message).toMatch(pattern);
			expect(w.calls).toHaveLength(0);
		});

	it("refuses a physicalId naming other content", async () => {
		const error = await rejection(
			resolverOf().reconcile(
				request(fixture, {}, `${TARGET}/team/app@sha256:${"a".repeat(64)}`),
				world().transport,
			),
		);
		expect(error.message).toMatch(/other content/u);
	});

	it("refuses a foreign product as RESOLVER_PRODUCT_UNSUPPORTED", async () => {
		const foreign = {
			...request(fixture),
			ref: { ...request(fixture).ref, productId: "oci-registry.repository/v1" },
		};
		const error = await rejection(
			resolverOf().reconcile(foreign, world().transport),
		);
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a source credential that is material rather than a locator, at construction", () => {
		expect(() =>
			registryOf({
				sourceRegistries: [{ host: SOURCE, credentialRef: "Bearer abc" }],
			}),
		).toThrow(ResolverError);
		expect(() =>
			registryOf({ registry: { host: "https://registry.target.test" } }),
		).toThrow(ResolverError);
	});
});

describe("source integrity: a mirror never substitutes (D22)", () => {
	it("refuses when the source cannot serve the digest", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const error = await rejection(
			resolverOf().reconcile(request(fixture), world().transport),
		);
		expect(error.message).toMatch(/never substitutes/u);
	});

	it("refuses blob bytes that do not hash to the descriptor digest", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		const layer = fixture.blobs[1];
		if (!layer) throw new Error("fixture has no layer");
		w.hosts.get(SOURCE)?.blobs.set(
			layer.digest,
			Uint8Array.from(layer.bytes, (byte) => byte ^ 1),
		);
		const error = await rejection(
			resolverOf().reconcile(request(fixture), w.transport),
		);
		expect(error.message).toMatch(/do not match the descriptor/u);
		expect(w.repo(TARGET, "team/app").manifests.size).toBe(0);
	});
});

describe("observe (read)", () => {
	it("reports undefined when the manifest is absent at the target", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		expect(
			await resolverOf().read?.(request(fixture), world().transport),
		).toBeUndefined();
	});

	it("reports tag→digest and shows tag drift as not ready", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const other = image({ platform: "other", binary: true });
		const w = world();
		seedImage(w, TARGET, "team/app", fixture);
		seedImage(w, TARGET, "team/app", other, ["prod"]);
		const read = await resolverOf().read?.(request(fixture), w.transport);
		expect(read?.outputs).toMatchObject({
			manifestPresent: true,
			tagsConverged: false,
			ready: false,
			lifecycleStatus: "pending",
			tagDigests: [{ tag: "prod", digest: other.digest }],
		});
		expect(w.mutations()).toBe(0);
	});
});

describe("delete", () => {
	function converged() {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, TARGET, "team/app", fixture, ["prod", "keep"]);
		return { fixture, w };
	}

	it("removes only the declared tags still pointing at the digest and keeps the manifest by default", async () => {
		const { fixture, w } = converged();
		await resolverOf().delete(request(fixture), w.transport);
		const repo = w.repo(TARGET, "team/app");
		expect(repo.tags.has("prod")).toBe(false);
		expect(repo.tags.get("keep")).toBe(fixture.digest);
		expect(repo.manifests.has(fixture.digest)).toBe(true);
	});

	it("leaves a declared tag that another writer re-pointed", async () => {
		const { fixture, w } = converged();
		const other = image({ platform: "other", binary: true });
		seedImage(w, TARGET, "team/app", other, ["prod"]);
		await resolverOf().delete(request(fixture), w.transport);
		expect(w.repo(TARGET, "team/app").tags.get("prod")).toBe(other.digest);
		expect(w.paths("DELETE")).toEqual([]);
	});

	it("deletes the manifest by digest only under allowManifestDelete", async () => {
		const { fixture, w } = converged();
		await resolverOf({ allowManifestDelete: true }).delete(
			request(fixture),
			w.transport,
		);
		expect(w.repo(TARGET, "team/app").manifests.has(fixture.digest)).toBe(
			false,
		);
	});

	it("refuses with a remediation when the registry cannot delete tags", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world("latin1", { tagDelete: false });
		seedImage(w, TARGET, "team/app", fixture, ["prod"]);
		const error = await rejection(
			resolverOf().delete(request(fixture), w.transport),
		);
		expect(error.message).toMatch(/does not delete tags.*Remediation:/u);
	});
});

describe("telemetry", () => {
	it("emits hobo.cd.resolver.* metrics with the action", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = world();
		seedImage(w, SOURCE, "ci/app", fixture);
		const points: ResolverMetricPoint[] = [];
		await resolverOf({
			metrics: { metrics: async (batch) => void points.push(...batch) },
			nowMs: () => 5,
		}).reconcile(request(fixture), w.transport);
		expect(points[0]?.attributes).toMatchObject({
			"hobo.provider.id": "oci-registry",
			"hobo.resolver.action": "create",
		});
	});
});

const live = {
	host: process.env.HOBO_OCI_LIVE_HOST,
	repository: process.env.HOBO_OCI_LIVE_REPOSITORY,
	digest: process.env.HOBO_OCI_LIVE_DIGEST,
	realm: process.env.HOBO_OCI_LIVE_REALM,
	username: process.env.HOBO_OCI_LIVE_USERNAME,
	password: process.env.HOBO_OCI_LIVE_PASSWORD,
};
const liveReady = Object.values(live).every(
	(value) => value !== undefined && value !== "",
);

describe("live lane (credential-gated)", () => {
	it.skipIf(!liveReady)(
		`observes a real registry image by digest${liveReady ? "" : " (skipped: set HOBO_OCI_LIVE_HOST, _REPOSITORY, _DIGEST, _REALM, _USERNAME, _PASSWORD)"}`,
		async () => {
			const { createBoundedFetchTransport } = await import("@hobo/core");
			const resolver = ociRegistryResolverRegistry({
				registry: { host: live.host ?? "", authRealms: [live.realm ?? ""] },
				resolveCredential: async () => ({
					kind: "basic",
					username: live.username ?? "",
					password: live.password ?? "",
				}),
			}).get(OCI_REGISTRY_IMAGE_PRODUCT_ID);
			const read = await resolver?.read?.(
				{
					ref: {
						slot: "service",
						productId: OCI_REGISTRY_IMAGE_PRODUCT_ID,
						logicalId: "live",
					},
					desired: {
						registry: live.host ?? "",
						repository: live.repository ?? "",
						digest: live.digest ?? "",
					},
					credentialRef: "env://HOBO_OCI_LIVE_PASSWORD",
				},
				createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
			);
			expect(read?.outputs.manifestPresent).toBe(true);
		},
	);
});
