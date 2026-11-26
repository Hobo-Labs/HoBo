import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { describe, expect, it } from "vitest";

import {
	createNetlifyClient,
	isNetlifyProviderError,
	NETLIFY_API_ALLOWED_HOSTS,
	type NetlifyClient,
	type NetlifyTransport,
	type SecretResolverPort,
	type TransportResponse,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

type PactInteraction = {
	readonly description: string;
	readonly request: { readonly method: string; readonly path: string };
	readonly response: {
		readonly status: number;
		readonly body?: JsonObject;
	};
};

type PactDocument = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly metadata: {
		readonly boundary: {
			readonly allowedHosts: readonly string[];
			readonly claimCeremonyHost: string;
		};
	};
	readonly interactions: readonly PactInteraction[];
};

function jsonStringList(value: JsonValue | undefined): readonly string[] {
	if (!isJsonArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		if (isJsonString(entry)) items.push(entry);
	}
	return items;
}

function parseInteraction(entry: JsonObject): PactInteraction | undefined {
	const request = isJsonObject(entry.request) ? entry.request : undefined;
	const response = isJsonObject(entry.response) ? entry.response : undefined;
	if (
		!isJsonString(entry.description) ||
		request === undefined ||
		response === undefined ||
		!isJsonString(request.method) ||
		!isJsonString(request.path)
	) {
		return undefined;
	}
	return {
		description: entry.description,
		request: { method: request.method, path: request.path },
		response: {
			status: isJsonNumber(response.status) ? response.status : 0,
			...(isJsonObject(response.body) ? { body: response.body } : undefined),
		},
	};
}

function loadPact(): PactDocument {
	const decoded = parseJsonObject(
		readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"contracts",
				"provider-netlify-site-api.pact.json",
			),
			"utf8",
		),
	);
	const consumer = isJsonObject(decoded.consumer)
		? decoded.consumer
		: undefined;
	const provider = isJsonObject(decoded.provider)
		? decoded.provider
		: undefined;
	const metadata = isJsonObject(decoded.metadata)
		? decoded.metadata
		: undefined;
	const boundary = isJsonObject(metadata?.boundary)
		? metadata.boundary
		: undefined;
	const interactionsRaw = decoded.interactions;
	if (
		!isJsonString(consumer?.name) ||
		!isJsonString(provider?.name) ||
		!isJsonString(boundary?.claimCeremonyHost) ||
		!isJsonArray(interactionsRaw) ||
		interactionsRaw.length === 0
	) {
		throw new Error("the pact file is malformed");
	}
	const interactions: PactInteraction[] = [];
	for (const entry of interactionsRaw) {
		if (!isJsonObject(entry)) {
			throw new Error("the pact file has a malformed interaction");
		}
		const parsed = parseInteraction(entry);
		if (parsed === undefined) {
			throw new Error("the pact file has a malformed interaction");
		}
		interactions.push(parsed);
	}
	return {
		consumer: { name: consumer.name },
		provider: { name: provider.name },
		metadata: {
			boundary: {
				allowedHosts: jsonStringList(boundary.allowedHosts),
				claimCeremonyHost: boundary.claimCeremonyHost,
			},
		},
		interactions,
	};
}

const pact = loadPact();

/** Replays the contract: an unlisted request is a contract violation. */
const transport: NetlifyTransport = {
	async request(request) {
		const url = new URL(request.url);
		const found = pact.interactions.find(
			(candidate) =>
				candidate.request.method === request.method &&
				candidate.request.path === url.pathname,
		);
		if (found === undefined) {
			throw new Error(`no interaction for ${request.method} ${url.pathname}`);
		}
		const response: TransportResponse = {
			status: found.response.status,
			headers: {},
			body: JSON.stringify(found.response.body ?? null),
		};
		return response;
	},
};

const tokenRef = parseSecretRef(
	"hobo-token://netlify/claiming-account/contract",
).ref;

const resolver: SecretResolverPort = {
	async resolve(ref) {
		return new SecretValue(
			parseSecretRef(ref),
			"FAKE-claiming-token-000000000000",
		);
	},
};

function client(): NetlifyClient {
	return createNetlifyClient({ transport, resolver });
}

describe("NetlifySiteApi pact (consumer contract)", () => {
	it("names the boundary and pins it to the official REST origin", () => {
		expect(pact.consumer.name).toBe("@hobo/provider-netlify");
		expect(pact.provider.name).toBe("NetlifySiteApi");
		expect(pact.metadata.boundary.allowedHosts).toEqual([
			...NETLIFY_API_ALLOWED_HOSTS,
		]);
		// The human ceremony host is recorded and never called.
		expect(pact.metadata.boundary.claimCeremonyHost).toBe("app.netlify.com");
	});

	it("carries no credential material: every authorization header is a placeholder and no claim URL appears", () => {
		const serialized = JSON.stringify(pact);
		for (const bearer of serialized.matchAll(/"Bearer ([^"]+)"/gu)) {
			expect(bearer[1]).toMatch(/^<redacted-[a-z-]+>$/u);
		}
		expect(serialized).not.toContain("app.netlify.com/claim");
	});

	it("reads the owning account as the ownership fact a claim has to move", async () => {
		const access = await client().probeSiteAccess({
			siteId: "site-claimed-demo",
			tokenRef,
		});
		expect(access.kind).toBe("readable");
		expect(access.kind === "readable" && access.site.accountId).toBe(
			"team-claiming",
		);
	});

	it("keeps forbidden and absent apart", async () => {
		expect(
			(
				await client().probeSiteAccess({
					siteId: "site-foreign-demo",
					tokenRef,
				})
			).kind,
		).toBe("forbidden");
		expect(
			(
				await client().probeSiteAccess({
					siteId: "site-reaped-demo",
					tokenRef,
				})
			).kind,
		).toBe("absent");
	});

	it("fails closed when the site response carries no owning account", async () => {
		try {
			await client().readSite({ siteId: "site-contract-drift", tokenRef });
			throw new Error("expected a provider error");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error)) {
				expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
			}
		}
	});
});
