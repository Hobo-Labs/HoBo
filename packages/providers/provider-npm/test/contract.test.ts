/**
 * Consumer PACT for the npm registry boundary. Two directions are checked:
 * every request the realizer emits across the full lifecycle (OIDC exchange,
 * publish, promote, observe, deprecate) is declared by an interaction, and
 * every interaction is exercised; the recorded responses are parsed by the
 * realizer exactly as served.
 */
import { readFileSync } from "node:fs";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	npmResolverRegistry,
} from "../src/index.js";
import { isJsonObject, isJsonString, type JsonValue } from "../src/json.js";
import {
	ID_TOKEN,
	memoryStore,
	options,
	PUBLISH_TOKEN,
	publishedPackument,
	registryWorld,
	request,
	TARBALL,
} from "./support/world.js";

interface Interaction {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly query?: string;
		readonly headers: Record<string, string>;
		readonly body?: JsonValue;
	};
	readonly response: { readonly status: number; readonly body: JsonValue };
}

// SAFETY: the pact is a checked-in document of this shape; the first test pins its identity.
const pact = JSON.parse(
	readFileSync(
		new URL("../contracts/provider-npm-registry.pact.json", import.meta.url),
		"utf8",
	),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
};

function keySet(value: JsonValue | undefined): string[] {
	if (isJsonObject(value)) return Object.keys(value).sort();
	return [isJsonString(value) ? "string" : "other"];
}

function matches(interaction: Interaction, request: TransportRequest): boolean {
	const url = new URL(request.url);
	if (interaction.request.method !== request.method) return false;
	if (interaction.request.path !== url.pathname) return false;
	if ((interaction.request.query ?? "") !== url.search.replace(/^\?/u, ""))
		return false;
	for (const name of Object.keys(interaction.request.headers))
		if (!(name in request.headers)) return false;
	if (interaction.request.body === undefined) return request.body === undefined;
	const body: unknown = JSON.parse(request.body ?? "null");
	return (
		JSON.stringify(keySet(body)) ===
		JSON.stringify(keySet(interaction.request.body))
	);
}

function recorded(description: string): Interaction {
	const found = pact.interactions.find(
		(entry) => entry.description === description,
	);
	if (!found) throw new Error(`pact has no interaction ${description}`);
	return found;
}

describe("npm registry consumer pact", () => {
	it("names the consumer and provider", () => {
		expect(pact.consumer.name).toBe("HoBoCdReconciler");
		expect(pact.provider.name).toBe("NpmCompatibleRegistry");
	});

	it("declares every request of the full lifecycle, and the lifecycle exercises every interaction", async () => {
		const seen: TransportRequest[] = [];
		const record = (world: ReturnType<typeof registryWorld>) => {
			const transport: HttpTransport = async (entry) => {
				seen.push(entry);
				return world.transport(entry);
			};
			return transport;
		};
		const token = npmResolverRegistry(options(memoryStore(TARBALL))).get(
			NPM_PACKAGE_VERSION_PRODUCT_ID,
		);
		const oidc = npmResolverRegistry(
			options(memoryStore(TARBALL), {
				auth: "oidc-trusted-publishing",
				resolveCredential: async () => ID_TOKEN,
			}),
		).get(NPM_PACKAGE_VERSION_PRODUCT_ID);
		const fresh = registryWorld();
		await token?.reconcile(request(), record(fresh));
		await token?.reconcile(request({ distTag: "stable" }), record(fresh));
		await token?.delete(request(), record(fresh));
		await oidc?.read?.(
			request(),
			record(
				registryWorld({
					bearer: PUBLISH_TOKEN,
					idToken: ID_TOKEN,
					packument: publishedPackument(TARBALL, { candidate: "1.2.3" }),
				}),
			),
		);
		for (const entry of seen)
			expect(
				pact.interactions.some((interaction) => matches(interaction, entry)),
				`${entry.method} ${entry.url} is not declared by the pact`,
			).toBe(true);
		for (const interaction of pact.interactions)
			expect(
				seen.some((entry) => matches(interaction, entry)),
				`interaction "${interaction.description}" is never exercised`,
			).toBe(true);
	});

	it("parses the recorded packument as the converged fixture version", async () => {
		const served = recorded("observe the published version and its dist-tags");
		const transport: HttpTransport = async () => ({
			status: served.response.status,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(served.response.body),
		});
		const outcome = await npmResolverRegistry(options(memoryStore(TARBALL)))
			.get(NPM_PACKAGE_VERSION_PRODUCT_ID)
			?.read?.(request(), transport);
		expect(outcome?.outputs).toMatchObject({
			ready: true,
			distTagVersion: "1.2.3",
		});
	});

	it("records the fixture tarball's real integrity in the publish document", () => {
		const publish = recorded("publish version 1.2.3 with an explicit dist-tag");
		// SAFETY: the publish interaction body is the npm publish document shape.
		const body = publish.request.body as {
			versions: Record<string, { dist: { integrity: string } }>;
			_attachments: Record<string, { length: number }>;
		};
		// SAFETY: the observe interaction body is an npm packument.
		const served = recorded("observe the published version and its dist-tags")
			.response.body as {
			versions: Record<string, { dist: { integrity: string } }>;
		};
		expect(body.versions["1.2.3"]?.dist.integrity).toBe(
			served.versions["1.2.3"]?.dist.integrity,
		);
		expect(body._attachments["@hobo-fixtures/widget-1.2.3.tgz"]?.length).toBe(
			TARBALL.byteLength,
		);
	});
});
