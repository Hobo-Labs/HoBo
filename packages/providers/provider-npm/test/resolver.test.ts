import { createHash } from "node:crypto";
import {
	parseResolveOutcome,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createNpmResolvers,
	NPM_DEFAULT_DEPRECATION_MESSAGE,
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	NpmOtpRequiredError,
	NpmVersionConflictError,
	npmProductRefusal,
	npmResolverRegistry,
} from "../src/index.js";
import {
	type DesiredOverrides,
	digestOf,
	ID_TOKEN,
	memoryStore,
	NAME,
	options,
	PUBLISH_TOKEN,
	publishedPackument,
	registryWorld,
	request,
	TAMPERED,
	TARBALL,
	TARBALL_124,
	TOKEN,
	UNSCOPED_NAME,
	UNSCOPED_TARBALL,
	unpublishedPackument,
} from "./support/world.js";

function resolverFor(
	store = memoryStore(TARBALL),
	overrides = {},
): ResourceResolver {
	const resolver = npmResolverRegistry(options(store, overrides)).get(
		NPM_PACKAGE_VERSION_PRODUCT_ID,
	);
	if (!resolver) throw new Error("npm resolver is not registered");
	return resolver;
}

function parsed(outcome: ResolveOutcome | undefined) {
	return parseResolveOutcome(JSON.parse(JSON.stringify(outcome)));
}

function conflictReason(error: ResolverError): string | undefined {
	return error instanceof NpmVersionConflictError ? error.reason : undefined;
}

async function refusal(promise: Promise<unknown>): Promise<ResolverError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ResolverError) return error;
		throw error;
	}
	throw new Error("expected a ResolverError refusal");
}

function sigstoreBundle(
	sha512Hex: string,
	purl = `pkg:npm/%40hobo-fixtures/widget@1.2.3`,
) {
	const statement = {
		_type: "https://in-toto.io/Statement/v1",
		subject: [{ name: purl, digest: { sha512: sha512Hex } }],
		predicateType: "https://slsa.dev/provenance/v1",
		predicate: {},
	};
	return new TextEncoder().encode(
		JSON.stringify({
			mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
			verificationMaterial: {},
			dsseEnvelope: {
				payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
				payloadType: "application/vnd.in-toto+json",
				signatures: [],
			},
		}),
	);
}

describe("npm realizer: converge", () => {
	it("publishes an absent version with an explicit dist-tag and reports create only after observing it", async () => {
		const world = registryWorld();
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.contract).toBe(RESOLVER_CONTRACT);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(`${NAME}@1.2.3`);
		expect(outcome.outputs).toMatchObject({
			ready: true,
			operationConfirmed: true,
			lifecycleStatus: "ready",
			distTag: "candidate",
			distTagVersion: "1.2.3",
			artifactDigest: digestOf(TARBALL),
			integrity: `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`,
		});
		const methods = world.requests.map((entry) => entry.method);
		expect(methods).toEqual(["GET", "PUT", "GET"]);
		const publish = JSON.parse(world.requests[1]?.body ?? "{}");
		expect(publish["dist-tags"]).toEqual({ candidate: "1.2.3" });
		const attachment = publish._attachments[`${NAME}-1.2.3.tgz`];
		expect(
			Buffer.from(attachment.data, "base64").equals(Buffer.from(TARBALL)),
		).toBe(true);
		expect(attachment.length).toBe(TARBALL.byteLength);
		expect(publish.versions["1.2.3"].description).toBe(
			"HoBo npm realizer fixture",
		);
	});

	it("is idempotent by digest: a converged version is noop (pinned) or adopt (unpinned) and mutates nothing", async () => {
		const world = registryWorld({
			packument: publishedPackument(TARBALL, { candidate: "1.2.3" }),
		});
		const resolver = resolverFor();
		const adopted = parsed(
			await resolver.reconcile(request(), world.transport),
		);
		const pinned = parsed(
			await resolver.reconcile(request({}, `${NAME}@1.2.3`), world.transport),
		);
		expect(adopted.action).toBe("adopt");
		expect(pinned.action).toBe("noop");
		expect(pinned.outputs).toEqual(adopted.outputs);
		expect(world.mutations()).toBe(0);
	});

	it("moves only the dist-tag when the version exists with matching integrity (the promotion lever)", async () => {
		const world = registryWorld({
			packument: publishedPackument(TARBALL, {
				candidate: "1.2.3",
				stable: "1.2.2",
			}),
		});
		const outcome = parsed(
			await resolverFor().reconcile(
				request({ distTag: "stable" }, `${NAME}@1.2.3`),
				world.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.distTagVersion).toBe("1.2.3");
		const puts = world.requests.filter((entry) => entry.method === "PUT");
		expect(puts.map((entry) => new URL(entry.url).pathname)).toEqual([
			`/-/package/${NAME}/dist-tags/stable`,
		]);
		expect(puts[0]?.body).toBe(JSON.stringify("1.2.3"));
	});

	it("never re-points a dist-tag desired state does not declare", async () => {
		const seeded = {
			latest: "1.2.4",
			beta: "1.2.4",
			candidate: "1.2.4",
			stable: "1.2.4",
		};
		const doc = publishedPackument(TARBALL_124, seeded, "1.2.4");
		const world = registryWorld({ packument: doc });
		const resolver = resolverFor();
		const others = (tag: string) =>
			Object.fromEntries(
				Object.entries(world.packument()?.["dist-tags"] ?? {}).filter(
					([name]) => name !== tag,
				),
			);
		const beforePublish = JSON.stringify(others("candidate"));
		const created = await resolver.reconcile(request(), world.transport);
		expect(created.action).toBe("create");
		const publish = JSON.parse(
			world.requests.find((entry) => entry.method === "PUT")?.body ?? "{}",
		);
		expect(publish["dist-tags"]).toEqual({ candidate: "1.2.3" });
		expect(Object.keys(publish.versions["1.2.3"])).not.toContain("dist-tags");
		expect(JSON.stringify(others("candidate"))).toBe(beforePublish);
		expect(world.packument()?.["dist-tags"]?.candidate).toBe("1.2.3");

		const beforePromote = JSON.stringify(others("stable"));
		const promoted = await resolver.reconcile(
			request({ distTag: "stable" }, `${NAME}@1.2.3`),
			world.transport,
		);
		expect(promoted.action).toBe("update");
		expect(JSON.stringify(others("stable"))).toBe(beforePromote);
		expect(world.packument()?.["dist-tags"]).toEqual({
			latest: "1.2.4",
			beta: "1.2.4",
			candidate: "1.2.3",
			stable: "1.2.3",
		});
		const tagMoves = world.requests.filter((entry) =>
			new URL(entry.url).pathname.includes("/dist-tags/"),
		);
		expect(tagMoves.map((entry) => new URL(entry.url).pathname)).toEqual([
			`/-/package/${NAME}/dist-tags/stable`,
		]);
	});

	it("refuses a version that exists with different bytes as a typed conflict and never overwrites", async () => {
		const world = registryWorld({
			packument: publishedPackument(TAMPERED, { latest: "1.2.3" }),
		});
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(error).toBeInstanceOf(NpmVersionConflictError);
		expect(conflictReason(error)).toBe("npm-version-integrity-mismatch");
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(world.mutations()).toBe(0);
	});

	it("refuses mismatching integrity when the registry records no shasum", async () => {
		const doc = publishedPackument(TAMPERED, { latest: "1.2.3" });
		delete doc.versions["1.2.3"].dist.shasum;
		const world = registryWorld({ packument: doc });
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(conflictReason(error)).toBe("npm-version-integrity-mismatch");
	});

	it("refuses to judge a version whose integrity names no strong hash", async () => {
		const doc = publishedPackument(TARBALL, { latest: "1.2.3" });
		doc.versions["1.2.3"].dist.integrity = "sha1-abc";
		const world = registryWorld({ packument: doc });
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(error.message).toContain("names no sha256/384/512 hash");
		expect(world.mutations()).toBe(0);
	});

	it("refuses a mismatching shasum even when the integrity matches", async () => {
		const doc = publishedPackument(TARBALL, { candidate: "1.2.3" });
		doc.versions["1.2.3"].dist.shasum = "0".repeat(40);
		const world = registryWorld({ packument: doc });
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(conflictReason(error)).toBe("npm-version-integrity-mismatch");
	});

	it("refuses a version that was published then unpublished (npm never reuses it)", async () => {
		const doc = publishedPackument(TARBALL_124, { latest: "1.2.4" }, "1.2.4");
		doc.time["1.2.3"] = "2026-01-01T00:00:00.000Z";
		const world = registryWorld({ packument: doc });
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(conflictReason(error)).toBe("npm-version-previously-unpublished");
		expect(world.mutations()).toBe(0);
	});

	it("refuses a version of a package unpublished in its entirety (time.unpublished.versions) without publishing", async () => {
		const world = registryWorld({
			packument: unpublishedPackument(["1.2.2", "1.2.3"]),
		});
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(conflictReason(error)).toBe("npm-version-previously-unpublished");
		expect(world.mutations()).toBe(0);
		const read = await refusal(
			resolverFor().read?.(request(), world.transport) ?? Promise.resolve(),
		);
		expect(conflictReason(read)).toBe("npm-version-previously-unpublished");
	});

	it("publishes a new version over a wholly unpublished package that does not list it", async () => {
		const world = registryWorld({ packument: unpublishedPackument(["1.2.2"]) });
		const outcome = await resolverFor().reconcile(request(), world.transport);
		expect(outcome.action).toBe("create");
	});

	it("confirms a publish with an uncached ?write=true read, so a CDN-cached 404 does not refuse it", async () => {
		const world = registryWorld({ cdn: true });
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.action).toBe("create");
		const reads = world.requests.filter((entry) => entry.method === "GET");
		expect(reads.map((entry) => new URL(entry.url).search)).toEqual([
			"",
			"?write=true",
		]);
		// The next pass still sees the CDN's stale 404, publishes, is refused
		// with 403 "cannot publish over", and the uncached read adopts it.
		const again = parsed(
			await resolverFor().reconcile(
				request({}, `${NAME}@1.2.3`),
				world.transport,
			),
		);
		expect(again.outputs.ready).toBe(true);
	});

	it("confirms a dist-tag move with an uncached read when the CDN still serves the old tag", async () => {
		const world = registryWorld({
			cdn: true,
			packument: publishedPackument(TARBALL, { candidate: "1.2.3" }),
		});
		const resolver = resolverFor();
		await resolver.read?.(request({ distTag: "stable" }), world.transport);
		const outcome = parsed(
			await resolver.reconcile(request({ distTag: "stable" }), world.transport),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.distTagVersion).toBe("1.2.3");
	});

	it("resolves a 403 'cannot publish over' after a stale read by observation: our bytes converge, other bytes conflict", async () => {
		const ours = registryWorld({ cdn: true });
		await resolverFor().read?.(request(), ours.transport);
		ours.setPackument(publishedPackument(TARBALL, { candidate: "1.2.3" }));
		const converged = parsed(
			await resolverFor().reconcile(request(), ours.transport),
		);
		expect(converged.outputs.ready).toBe(true);
		expect(ours.packument()?.versions?.["1.2.3"]?.dist.integrity).toBe(
			converged.outputs.integrity,
		);

		const theirs = registryWorld({ cdn: true });
		await resolverFor().read?.(request(), theirs.transport);
		theirs.setPackument(publishedPackument(TAMPERED, { latest: "1.2.3" }));
		const error = await refusal(
			resolverFor().reconcile(request(), theirs.transport),
		);
		expect(conflictReason(error)).toBe("npm-version-integrity-mismatch");
	});

	it("resolves a lost publish reply by observation: the publish landed, so it is create", async () => {
		const world = registryWorld();
		world.faults.dropReplyOnce = true;
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.ready).toBe(true);
	});

	it("never reports convergence for a publish it cannot observe, and the next pass converges", async () => {
		const world = registryWorld();
		world.faults.lostBeforeOnce = true;
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toContain("not observable");
		expect(error.message).toContain("reply was lost");
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.action).toBe("create");
	});

	it("does not trust a 200 publish the registry does not show (I5)", async () => {
		const world = registryWorld();
		world.faults.invisiblePublishOnce = true;
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(error.message).toContain("HTTP 200");
		expect(error.message).toContain("not observable");
	});

	it("treats a 403 publish whose version is observed with our bytes as converged (a racing earlier attempt)", async () => {
		const world = registryWorld();
		world.faults.appliedStatusOnce = 403;
		const outcome = parsed(
			await resolverFor().reconcile(request(), world.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.ready).toBe(true);
	});

	it("maps a 401 Basic, Bearer challenge on publish to a credential refusal", async () => {
		const world = registryWorld();
		world.faults.statusOnce = 401;
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(error.code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(error).not.toBeInstanceOf(NpmOtpRequiredError);
		expect(error.message).toContain("re-issue the registry credential");
	});

	it("maps a 401 www-authenticate: OTP challenge to a distinct 2FA refusal naming automation tokens and trusted publishing", async () => {
		const world = registryWorld();
		world.faults.otpOnce = true;
		const error = await refusal(
			resolverFor().reconcile(request(), world.transport),
		);
		expect(error).toBeInstanceOf(NpmOtpRequiredError);
		expect(error.code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(error.message).toContain("one-time password");
		expect(error.message).toContain("automation token");
		expect(error.message).toContain("bypass-2FA");
		expect(error.message).toContain("OIDC trusted publishing");
		expect(error.message).not.toContain("re-issue the registry credential");
		expect(error.message).not.toContain(TOKEN);
		expect(world.packument()).toBeUndefined();
	});

	it("maps a 401 whose body asks for a one-time password but sends no challenge to the 2FA refusal", async () => {
		const otp = registryWorld();
		const transport: typeof otp.transport = async (entry) =>
			entry.method === "PUT"
				? {
						status: 401,
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							error: "You must provide a one-time pass. Upgrade your client.",
						}),
					}
				: otp.transport(entry);
		const error = await refusal(resolverFor().reconcile(request(), transport));
		expect(error).toBeInstanceOf(NpmOtpRequiredError);
	});

	it("attaches the Freight's Sigstore provenance bundle and observes the registry's attestation", async () => {
		const sha512Hex = createHash("sha512").update(TARBALL).digest("hex");
		const bundle = sigstoreBundle(sha512Hex);
		const world = registryWorld();
		const outcome = parsed(
			await resolverFor(memoryStore(TARBALL, bundle)).reconcile(
				request({ provenanceDigest: digestOf(bundle) }),
				world.transport,
			),
		);
		expect(outcome.outputs.provenanceObserved).toBe(true);
		const publish = JSON.parse(
			world.requests.find((entry) => entry.method === "PUT")?.body ?? "{}",
		);
		const attachment = publish._attachments[`${NAME}-1.2.3.sigstore`];
		expect(attachment.content_type).toBe(
			"application/vnd.dev.sigstore.bundle.v0.3+json",
		);
		expect(attachment.data).toBe(new TextDecoder().decode(bundle));
	});

	it("refuses a provenance bundle that attests other bytes before publishing", async () => {
		const bundle = sigstoreBundle("0".repeat(128));
		const world = registryWorld();
		const error = await refusal(
			resolverFor(memoryStore(TARBALL, bundle)).reconcile(
				request({ provenanceDigest: digestOf(bundle) }),
				world.transport,
			),
		);
		expect(error.message).toContain("does not attest");
		expect(world.mutations()).toBe(0);
	});
});

describe("npm realizer: OIDC trusted publishing", () => {
	const unscoped = (overrides: DesiredOverrides = {}) =>
		request({
			packageName: UNSCOPED_NAME,
			artifactDigest: digestOf(UNSCOPED_TARBALL),
			...overrides,
		});
	const oidc = () =>
		resolverFor(memoryStore(UNSCOPED_TARBALL), {
			auth: "oidc-trusted-publishing",
			resolveCredential: async () => ID_TOKEN,
		});

	it("exchanges the CI ID token through the transport and publishes with the short-lived token", async () => {
		const world = registryWorld({
			bearer: PUBLISH_TOKEN,
			idToken: ID_TOKEN,
			name: UNSCOPED_NAME,
		});
		const outcome = await oidc().reconcile(unscoped(), world.transport);
		expect(outcome.action).toBe("create");
		expect(world.requests[0]?.method).toBe("POST");
		expect(new URL(world.requests[0]?.url ?? "").pathname).toBe(
			`/-/npm/v1/oidc/token/exchange/package/${UNSCOPED_NAME}`,
		);
		const text = JSON.stringify(outcome);
		expect(text).not.toContain(PUBLISH_TOKEN);
		expect(text).not.toContain(ID_TOKEN);
	});

	it("refuses an exchange the registry denies without echoing the ID token", async () => {
		const world = registryWorld({
			bearer: PUBLISH_TOKEN,
			idToken: "other",
			name: UNSCOPED_NAME,
		});
		const error = await refusal(oidc().reconcile(unscoped(), world.transport));
		expect(error.message).toContain("trusted publisher");
		expect(error.message).not.toContain(ID_TOKEN);
	});

	it("refuses a scoped name before any request: npmjs routes the exchange only for the %2f-escaped name, which the transport guard refuses", async () => {
		const world = registryWorld({ bearer: PUBLISH_TOKEN, idToken: ID_TOKEN });
		const error = await refusal(
			resolverFor(memoryStore(TARBALL), {
				auth: "oidc-trusted-publishing",
				resolveCredential: async () => ID_TOKEN,
			}).reconcile(request(), world.transport),
		);
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(error.message).toContain("scoped");
		expect(world.requests).toHaveLength(0);
	});

	it("is unsupported on registries without an exchange", () => {
		expect(() =>
			createNpmResolvers(
				options(memoryStore(TARBALL), {
					registry: { kind: "github-packages" },
					auth: "oidc-trusted-publishing",
				}),
			),
		).toThrow(/RESOLVER|trusted-publishing exchange/u);
	});
});

describe("npm realizer: observe", () => {
	it("read returns undefined for an unpublished version and the converged outcome otherwise", async () => {
		const resolver = resolverFor();
		expect(
			await resolver.read?.(request(), registryWorld().transport),
		).toBeUndefined();
		const world = registryWorld({
			packument: publishedPackument(TARBALL, { latest: "1.2.3" }),
		});
		const observed = parsed(await resolver.read?.(request(), world.transport));
		expect(observed.outputs).toMatchObject({
			ready: false,
			lifecycleStatus: "pending",
			distTagVersion: null,
		});
		expect(world.mutations()).toBe(0);
	});
});

describe("npm realizer: delete deprecates, never unpublishes", () => {
	it("deprecates the version, observes it, and is idempotent", async () => {
		const world = registryWorld({
			packument: publishedPackument(TARBALL, { latest: "1.2.3" }),
		});
		const resolver = resolverFor();
		await resolver.delete(request(), world.transport);
		expect(world.packument()?.versions?.["1.2.3"]?.deprecated).toBe(
			NPM_DEFAULT_DEPRECATION_MESSAGE,
		);
		expect(world.requests.some((entry) => entry.method === "DELETE")).toBe(
			false,
		);
		expect(new URL(world.requests[0]?.url ?? "").search).toBe("?write=true");
		const before = world.mutations();
		await resolver.delete(request(), world.transport);
		expect(world.mutations()).toBe(before);
		const observed = parsed(await resolver.read?.(request(), world.transport));
		expect(observed.outputs.deprecated).toBe(true);
	});

	it("uses the desired deprecation message", async () => {
		const world = registryWorld({
			packument: publishedPackument(TARBALL, { latest: "1.2.3" }),
		});
		await resolverFor().delete(
			request({ deprecationMessage: "use 2.x" }),
			world.transport,
		);
		expect(world.packument()?.versions?.["1.2.3"]?.deprecated).toBe("use 2.x");
	});

	it("treats an absent version as already retired and never deprecates other bytes", async () => {
		const empty = registryWorld();
		await resolverFor().delete(request(), empty.transport);
		expect(empty.mutations()).toBe(0);
		const foreign = registryWorld({
			packument: publishedPackument(TAMPERED, { latest: "1.2.3" }),
		});
		await expect(
			resolverFor().delete(request(), foreign.transport),
		).rejects.toBeInstanceOf(NpmVersionConflictError);
		expect(foreign.mutations()).toBe(0);
	});

	it("refuses the unpublish product by policy", () => {
		const error = npmProductRefusal("npm.package-unpublish/v1");
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(error.message).toContain("refused by policy");
	});
});

describe("npm realizer: parse boundary", () => {
	const cases: [string, DesiredOverrides, string][] = [
		["no explicit dist-tag", { distTag: undefined }, "distTag"],
		["a semver-range dist-tag", { distTag: "v2" }, "distTag"],
		[
			"another registry",
			{ registry: "https://evil.example" },
			"differs from the bound registry",
		],
		["an unknown key", { replicas: 3 }, "desired.replicas"],
		["build metadata", { version: "1.2.3+build.1" }, "build metadata"],
		["a mutable artifact", { artifactDigest: "latest" }, "artifactDigest"],
		[
			"a foreign coordinate",
			{ artifactCoordinate: `store://memory/sha256:${"a".repeat(64)}` },
			"artifactCoordinate",
		],
		[
			"a tarball for another version",
			{ version: "1.2.4" },
			"not @hobo-fixtures/widget@1.2.4",
		],
	];
	for (const [label, desired, message] of cases)
		it(`refuses ${label}`, async () => {
			const world = registryWorld();
			const error = await refusal(
				resolverFor().reconcile(request(desired), world.transport),
			);
			expect(error.message).toContain(message);
			expect(world.requests).toHaveLength(0);
		});

	it("refuses bytes that do not hash to the Freight digest, and a missing blob", async () => {
		const swapped = memoryStore();
		swapped.map.set(digestOf(TARBALL), TAMPERED);
		expect(
			(
				await refusal(
					resolverFor(swapped).reconcile(request(), registryWorld().transport),
				)
			).message,
		).toContain("do not hash to the Freight digest");
		expect(
			(
				await refusal(
					resolverFor(memoryStore()).reconcile(
						request(),
						registryWorld().transport,
					),
				)
			).message,
		).toContain("not in the artifact store");
	});

	it("refuses another product with RESOLVER_PRODUCT_UNSUPPORTED", async () => {
		const base = request();
		const other: ResolveRequest = {
			...base,
			ref: { ...base.ref, productId: "npm.other/v1" },
		};
		const error = await refusal(
			resolverFor().reconcile(other, registryWorld().transport),
		);
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a value-shaped credentialRef before any request (I9)", async () => {
		const world = registryWorld();
		const error = await refusal(
			resolverFor().reconcile(
				{ ...request(), credentialRef: `Bearer ${TOKEN}` },
				world.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(error.message).not.toContain(TOKEN);
		expect(world.requests).toHaveLength(0);
	});

	it("requires scoped names on GitHub Packages and refuses provenance off npmjs", async () => {
		const github = npmResolverRegistry(
			options(memoryStore(TARBALL), { registry: { kind: "github-packages" } }),
		).get(NPM_PACKAGE_VERSION_PRODUCT_ID);
		const unscoped = await refusal(
			github?.reconcile(
				request({
					registry: "https://npm.pkg.github.com",
					packageName: "widget",
				}),
				registryWorld({ base: "https://npm.pkg.github.com" }).transport,
			) ?? Promise.resolve(),
		);
		expect(unscoped.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		const provenance = await refusal(
			github?.reconcile(
				request({
					registry: "https://npm.pkg.github.com",
					provenanceDigest: digestOf(TARBALL),
				}),
				registryWorld({ base: "https://npm.pkg.github.com" }).transport,
			) ?? Promise.resolve(),
		);
		expect(provenance.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("publishes to a Verdaccio origin with a port and base path, and nowhere else", async () => {
		const base = "https://npm.internal.example:4873/registry";
		const world = registryWorld({ base });
		const resolver = npmResolverRegistry(
			options(memoryStore(TARBALL), {
				registry: { kind: "verdaccio", origin: `${base}/` },
			}),
		).get(NPM_PACKAGE_VERSION_PRODUCT_ID);
		const outcome = await resolver?.reconcile(
			request({ registry: base }),
			world.transport,
		);
		expect(outcome?.action).toBe("create");
		for (const entry of world.requests)
			expect(entry.url.startsWith(`${base}/`)).toBe(true);
	});

	it("refuses an http or credentialed Verdaccio origin", () => {
		for (const origin of [
			"http://npm.internal.example",
			"https://user:pw@npm.internal.example",
		])
			expect(() =>
				createNpmResolvers(
					options(memoryStore(), { registry: { kind: "verdaccio", origin } }),
				),
			).toThrow(ResolverError);
	});
});

describe("npm realizer: credentials never leak (I9)", () => {
	it("keeps the token out of outcomes and refusals", async () => {
		const world = registryWorld();
		const outcome = await resolverFor().reconcile(request(), world.transport);
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
		const conflict = await refusal(
			resolverFor().reconcile(
				request(),
				registryWorld({ packument: publishedPackument(TAMPERED, {}) })
					.transport,
			),
		);
		expect(conflict.message).not.toContain(TOKEN);
		const denied = registryWorld({ bearer: "someone-else" });
		const unauthorized = await refusal(
			resolverFor().reconcile(request(), denied.transport),
		);
		expect(unauthorized.code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(unauthorized.message).not.toContain(TOKEN);
	});
});
