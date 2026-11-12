// Provider verification for the two boundaries this package owns:
//   contracts/resolver-component-host.pact.json — the ResourceResolver seam
//     the CD reconciler consumes;
//   contracts/resolver-guest-imports.pact.json — the host imports a
//     hobo:resolver component consumes.
// Each interaction is replayed against the real host and the response body
// must contain the pact body (subset match).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JsonValue } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	buildReferenceComponent,
	httpArtifactUpload,
} from "../src/components/index.js";
import { createFakeUploadEndpoint } from "../src/conformance/index.js";
import { defineResolverGuest, ok, outcome } from "../src/guest/index.js";
import type { WitEgressResult } from "../src/guest/types.js";
import {
	componentResolvers,
	isComponentResolver,
	ResolverComponentError,
} from "../src/index.js";
import { isJsonArray, isJsonObject } from "../src/json.js";
import { manifestJson } from "./fixtures.js";
import {
	CREDENTIAL_REF,
	hosted,
	request,
	respond,
	SECRET,
	Upstream,
} from "./harness.js";

interface Interaction {
	readonly description: string;
	readonly request: { readonly path: string; readonly body?: JsonValue };
	readonly response: { readonly status: number; readonly body: JsonValue };
}
interface Pact {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly Interaction[];
}

function pact(name: string): Pact {
	return JSON.parse(
		readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8"),
	);
}

function contains(actual: JsonValue | undefined, expected: JsonValue): boolean {
	if (isJsonArray(expected))
		return (
			isJsonArray(actual) &&
			expected.length === actual.length &&
			expected.every((item, index) => contains(actual[index], item))
		);
	if (!isJsonObject(expected)) return actual === expected;
	if (!isJsonObject(actual)) return false;
	return Object.entries(expected).every(([key, value]) =>
		contains(actual[key], value),
	);
}

function interaction(document: Pact, path: string): Interaction {
	const found = document.interactions.find(
		(entry) => entry.request.path === path,
	);
	if (found === undefined)
		throw new Error(`pact has no interaction for ${path}`);
	return found;
}

const sha = (text: string) =>
	`sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("pact: ResolverComponentHost (consumer @hobo/cd/reconcile)", () => {
	const document = pact("resolver-component-host.pact.json");

	it("is a well-formed pact", () => {
		expect(document.consumer.name).toBe("@hobo/cd/reconcile");
		expect(document.provider.name).toBe("ResolverComponentHost");
		expect(document.interactions.length).toBeGreaterThanOrEqual(4);
	});

	it("honors reconcile, noop and observe interactions", async () => {
		const reference = httpArtifactUpload([
			{ host: "static.example.net", credential: true },
		]);
		const built = buildReferenceComponent(reference);
		const { component } = await hosted(
			built.manifestJson,
			reference.guest,
			reference.source,
		);
		const [resolver] = componentResolvers({ components: [component] });
		if (resolver === undefined || !isComponentResolver(resolver))
			throw new Error("no resolver");
		const endpoint = createFakeUploadEndpoint({
			host: "static.example.net",
			token: SECRET,
		});
		const desired = {
			uploadUrl: "https://static.example.net/site/index.html",
			artifactDigest: sha("v1"),
			content: "v1",
		};
		const reconcile = document.interactions.filter(
			(entry) =>
				entry.request.path.endsWith("/reconcile") &&
				entry.request.path.includes("artifact-upload"),
		);
		const first = await resolver.reconcile(
			request("http/artifact-upload", desired),
			endpoint.transport,
		);
		expect(
			contains(
				JSON.parse(JSON.stringify(first)),
				reconcile[0]?.response.body ?? null,
			),
		).toBe(true);
		const second = await resolver.reconcile(
			request("http/artifact-upload", desired, first.physicalId),
			endpoint.transport,
		);
		expect(
			contains(
				JSON.parse(JSON.stringify(second)),
				reconcile[1]?.response.body ?? null,
			),
		).toBe(true);
		const observe = interaction(
			document,
			"/resolver/http/artifact-upload/observe",
		);
		const observed = await resolver.observe(
			request(
				"http/artifact-upload",
				{ ...desired, lastModified: "yesterday" },
				first.physicalId,
			),
			endpoint.transport,
			["digest", "contentType"],
		);
		expect(
			contains(
				{
					driftKind: observed?.driftKind ?? "x",
					retained: observed?.retained ?? [],
					kind: observed?.kind ?? "",
				},
				observe.response.body,
			),
		).toBe(true);
	});

	it("honors the egress refusal interaction", async () => {
		const expected = interaction(document, "/resolver/acme/site/reconcile");
		const guest = defineResolverGuest((host) => ({
			describe: async () => ({
				componentId: "acme-static",
				version: "1.2.3",
				classes: [
					{
						productId: "acme/site",
						slot: "web",
						retainedFields: ["replicas"],
						observeFields: ["tls.version", "cacheTtl"],
						directives: ["forceDelete"],
					},
				],
			}),
			reconcile: async () => {
				await host.send({
					method: "GET",
					url: "https://evil.example/",
					headers: [],
					body: null,
				});
				return ok(outcome("create", "x", {}));
			},
			read: async () => ok(null),
			delete: async () => ok(null),
			instances: async () => ok([]),
		}));
		const { component } = await hosted(manifestJson(), guest, "pact-egress");
		const [resolver] = componentResolvers({ components: [component] });
		let body: JsonValue = null;
		try {
			await resolver?.reconcile(
				request("acme/site", {}),
				new Upstream().transport,
			);
		} catch (error) {
			if (error instanceof ResolverComponentError)
				body = { code: error.code, componentCode: error.componentCode };
		}
		expect(contains(body, expected.response.body)).toBe(true);
	});
});

describe("pact: ResolverComponentHostImports (consumer hobo:resolver guest)", () => {
	const document = pact("resolver-guest-imports.pact.json");

	it("honors authorized-fetch and send interactions", async () => {
		const results: WitEgressResult[] = [];
		const fetch = interaction(
			document,
			"/import/hobo:resolver/host@0.1.0/authorized-fetch",
		);
		const send = interaction(
			document,
			"/import/wasi:http/outgoing-handler@0.2.0/send",
		);
		const guest = defineResolverGuest((host) => ({
			describe: async () => ({
				componentId: "acme-static",
				version: "1.2.3",
				classes: [
					{
						productId: "acme/site",
						slot: "web",
						retainedFields: ["replicas"],
						observeFields: ["tls.version", "cacheTtl"],
						directives: ["forceDelete"],
					},
				],
			}),
			reconcile: async () => {
				results.push(
					await host.authorizedFetch(
						{
							method: "GET",
							url: "https://api.acme.test/v1/site",
							headers: [],
							body: null,
						},
						CREDENTIAL_REF,
					),
				);
				results.push(
					await host.send({
						method: "GET",
						url: "https://evil.example/",
						headers: [],
						body: null,
					}),
				);
				return ok(outcome("noop", "x", {}));
			},
			read: async () => ok(null),
			delete: async () => ok(null),
			instances: async () => ok([]),
		}));
		const { component } = await hosted(manifestJson(), guest, "pact-imports");
		const [resolver] = componentResolvers({ components: [component] });
		const upstream = new Upstream().route("GET https://api.acme.test/v1/", () =>
			respond(200, "{}"),
		);
		await resolver
			?.reconcile(request("acme/site", {}), upstream.transport)
			.catch(() => undefined);
		expect(
			contains(JSON.parse(JSON.stringify(results[0])), fetch.response.body),
		).toBe(true);
		expect(
			contains(JSON.parse(JSON.stringify(results[1])), send.response.body),
		).toBe(true);
		expect(upstream.requests[0]?.headers.authorization).toBe(
			`Bearer ${SECRET}`,
		);
	});
});
