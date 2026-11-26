/**
 * Contracts around the realizer: the distribution pact (every request the
 * realizer emits is declared there, and the recorded token shapes parse), the
 * shared resolver conformance kit, I14 coverage and the traffic profile, and
 * the CUE data models, vetted with the pinned cue binary.
 */
import { readFileSync } from "node:fs";
import {
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	type ResolveRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	OCI_REGISTRY_HOSTING_COVERAGE,
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT,
	OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE,
	ociRegistryProductRefusal,
	ociRegistryResolverRegistry,
	parseChallenge,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
import { cueVet } from "./support/cue-vet.js";
import { FakeRegistryWorld } from "./support/fake-registry.js";
import { attestation, image, index } from "./support/fixtures.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

const TARGET = "registry.target.test";
const SOURCE = "registry.source.test";
const REALM = "https://auth.target.test/token";
const SOURCE_REALM = "https://auth.source.test/token";

interface PactRule {
	readonly description: string;
	readonly method: string;
	readonly path: RegExp;
	readonly status: number;
	readonly body: JsonValue | undefined;
}

function loadPact(): readonly PactRule[] {
	const pact = parseJsonObject(
		readFileSync(
			new URL(
				"../contracts/provider-oci-registry-distribution.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	if (!isJsonArray(pact.interactions))
		throw new Error("pact declares no interactions");
	return pact.interactions.map((entry) => {
		if (
			!isJsonObject(entry) ||
			!isJsonObject(entry.request) ||
			!isJsonObject(entry.response)
		)
			throw new Error("malformed pact interaction");
		const rules = entry.matchingRules;
		const matcher =
			isJsonObject(rules) &&
			isJsonObject(rules.request) &&
			isJsonObject(rules.request.path) &&
			isJsonArray(rules.request.path.matchers)
				? rules.request.path.matchers[0]
				: undefined;
		if (
			!isJsonObject(matcher) ||
			!isJsonString(matcher.regex) ||
			!isJsonString(entry.request.method) ||
			!isJsonString(entry.description)
		)
			throw new Error("pact interaction has no path regex");
		return {
			description: entry.description,
			method: entry.request.method,
			path: new RegExp(matcher.regex, "u"),
			status: Number(entry.response.status),
			body: entry.response.body,
		};
	});
}

function fullWorld() {
	const w = new FakeRegistryWorld("latin1", [
		{
			host: TARGET,
			auth: {
				kind: "bearer",
				realm: REALM,
				service: TARGET,
				username: "robot",
				password: "fixture-pw",
			},
		},
		{
			host: SOURCE,
			auth: {
				kind: "bearer",
				realm: SOURCE_REALM,
				service: SOURCE,
				anonymousPull: true,
			},
			blobRedirectTo: "storage.source.test",
		},
	]);
	return w;
}

function registry() {
	return ociRegistryResolverRegistry({
		registry: { host: TARGET, authRealms: [REALM] },
		sourceRegistries: [
			{
				host: SOURCE,
				authRealms: [SOURCE_REALM],
				blobRedirectHosts: ["storage.source.test"],
			},
		],
		resolveCredential: async () => ({
			kind: "basic",
			username: "robot",
			password: "fixture-pw",
		}),
		transportBodyEncoding: "latin1",
		chunkBytes: 400,
	});
}

function request(
	digest: string,
	extra: Readonly<Record<string, JsonValue | undefined>> = {},
): ResolveRequest {
	return JSON.parse(
		JSON.stringify({
			ref: {
				slot: "service",
				productId: OCI_REGISTRY_IMAGE_PRODUCT_ID,
				logicalId: "app-image",
			},
			desired: {
				registry: TARGET,
				repository: "team/app",
				digest,
				tags: ["prod"],
				sourceRegistry: SOURCE,
				sourceRepository: "ci/app",
				...extra,
			},
			credentialRef: "vault://oci/target",
		}),
	);
}

describe("distribution pact", () => {
	it("every request across copy, tag, referrers, observe and delete is declared by the pact", async () => {
		const pact = loadPact();
		const amd = image({ platform: "amd64", binary: true, size: 900 });
		const fixture = index([amd]);
		const att = attestation(fixture);
		const w = fullWorld();
		for (const entry of [amd, fixture, att]) {
			for (const blob of entry.blobs) w.seedBlob(SOURCE, "ci/app", blob.bytes);
			w.seedManifest(SOURCE, "ci/app", entry.text, entry.mediaType);
		}
		const resolver = registry().get(OCI_REGISTRY_IMAGE_PRODUCT_ID);
		await resolver?.reconcile(request(fixture.digest), w.transport);
		await resolver?.read?.(request(fixture.digest), w.transport);
		await ociRegistryResolverRegistry({
			registry: { host: TARGET, authRealms: [REALM] },
			resolveCredential: async () => ({
				kind: "basic",
				username: "robot",
				password: "fixture-pw",
			}),
			allowManifestDelete: true,
		})
			.get(OCI_REGISTRY_IMAGE_PRODUCT_ID)
			?.delete(
				request(fixture.digest, {
					sourceRegistry: undefined,
					sourceRepository: undefined,
				}),
				w.transport,
			);
		expect(w.calls.length).toBeGreaterThan(20);
		const undeclared = w.calls
			.map((call) => ({
				method: call.method,
				path: new URL(call.url).pathname,
			}))
			.filter(
				(call) =>
					!pact.some(
						(rule) => rule.method === call.method && rule.path.test(call.path),
					),
			);
		expect(undeclared).toEqual([]);
		for (const method of ["HEAD", "GET", "POST", "PATCH", "PUT", "DELETE"])
			expect(w.calls.some((call) => call.method === method)).toBe(true);
	});

	it("the recorded token responses (token and access_token shapes) are both accepted", () => {
		const tokens = loadPact().filter((rule) => rule.path.test("/token"));
		expect(tokens).toHaveLength(2);
		const tokenFields = tokens.map((rule) =>
			Object.keys(Object(rule.body)).sort(),
		);
		expect(tokenFields).toEqual([
			["expires_in", "token"],
			["access_token", "expires_in"],
		]);
	});

	it("parses the recorded bearer challenge", () => {
		expect(
			parseChallenge(
				'Bearer realm="https://auth.target.test/token",service="registry.target.test",scope="repository:team/app:pull"',
			),
		).toEqual({
			scheme: "bearer",
			params: {
				realm: "https://auth.target.test/token",
				service: "registry.target.test",
				scope: "repository:team/app:pull",
			},
		});
	});
});

describeResolverConformance("oci-registry.image/v1", () => {
	const fixture = image({ platform: "amd64", binary: true });
	const w = fullWorld();
	for (const blob of fixture.blobs) w.seedBlob(TARGET, "team/app", blob.bytes);
	w.seedManifest(TARGET, "team/app", fixture.text, fixture.mediaType, ["prod"]);
	return {
		registry: registry(),
		coverage: OCI_REGISTRY_HOSTING_COVERAGE,
		request: request(fixture.digest),
		transport: w.transport,
		mutations: () => w.mutations(),
		secret: "fixture-pw",
	};
});

describe("I14 coverage and traffic profile", () => {
	it("kind 'other', no offering, no fallback, every portable offering declared absent", () => {
		expect(OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE);
		expect(OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE.offerings).toEqual([]);
		expect(OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT).toHaveLength(17);
		expect(OCI_REGISTRY_HOSTING_COVERAGE.traffic.absent).toHaveLength(17);
	});

	it("a required canary or even the in-process floor is refused (I6)", () => {
		for (const feature of ["edge.canary", "inprocess.weighted"] as const)
			expect(
				matchTrafficRoutingOfferings(OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE, {
					features: [feature],
					negotiation: "require",
				}).kind,
			).toBe("none");
	});

	it("refuses repository and retention products with typed RESOLVER_PRODUCT_UNSUPPORTED", () => {
		const refusal = ociRegistryProductRefusal("oci-registry.repository/v1");
		expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(refusal?.message).toMatch(/Remediation:/u);
		expect(
			ociRegistryProductRefusal(OCI_REGISTRY_IMAGE_PRODUCT_ID),
		).toBeUndefined();
	});
});

describe("CUE data models", () => {
	it("reconcile outputs satisfy #OciImageOutputs", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const att = attestation(fixture);
		const w = fullWorld();
		for (const entry of [fixture, att]) {
			for (const blob of entry.blobs) w.seedBlob(SOURCE, "ci/app", blob.bytes);
			w.seedManifest(SOURCE, "ci/app", entry.text, entry.mediaType);
		}
		const outcome = await registry()
			.get(OCI_REGISTRY_IMAGE_PRODUCT_ID)
			?.reconcile(request(fixture.digest), w.transport);
		expect(() =>
			cueVet(
				"oci_image.cue",
				"#OciImageOutputs",
				JSON.stringify(outcome?.outputs),
			),
		).not.toThrow();
	});

	it("drifted read outputs satisfy #OciImageOutputs too", async () => {
		const fixture = image({ platform: "amd64", binary: true });
		const w = fullWorld();
		w.seedManifest(TARGET, "team/app", fixture.text, fixture.mediaType);
		const read = await registry()
			.get(OCI_REGISTRY_IMAGE_PRODUCT_ID)
			?.read?.(request(fixture.digest), w.transport);
		expect(read?.outputs.ready).toBe(false);
		expect(() =>
			cueVet(
				"oci_image.cue",
				"#OciImageOutputs",
				JSON.stringify(read?.outputs),
			),
		).not.toThrow();
	});

	it("a request's desired satisfies #OciImageDesired, and a tag-shaped digest does not", () => {
		const fixture = image({ platform: "amd64", binary: true });
		expect(() =>
			cueVet(
				"oci_image.cue",
				"#OciImageDesired",
				JSON.stringify(request(fixture.digest).desired),
			),
		).not.toThrow();
		expect(() =>
			cueVet(
				"oci_image.cue",
				"#OciImageDesired",
				JSON.stringify(request("latest").desired),
			),
		).toThrow();
	});

	it("coverage satisfies #HostingCoverage", () => {
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#HostingCoverage",
				JSON.stringify(OCI_REGISTRY_HOSTING_COVERAGE),
			),
		).not.toThrow();
	});
});
