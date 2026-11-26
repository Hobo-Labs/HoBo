import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { describe, expect, it } from "vitest";

import {
	createProjectTransferRequest,
	getProject,
	isVercelProviderError,
	observeOrAdoptProject,
	PROJECT_TRANSFER_CODE_TTL_MS,
	revokeSponsoringToken,
	type SponsoringCredential,
	type TransportResponse,
	type VercelTransport,
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
		readonly boundary: { readonly allowedHosts: readonly string[] };
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
				"provider-vercel-project-transfer-api.pact.json",
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
			boundary: { allowedHosts: jsonStringList(boundary?.allowedHosts) },
		},
		interactions,
	};
}

const pact = loadPact();

const SPONSOR_ACCOUNT = "team-hobo-sponsor";

function interaction(method: string, pathname: string): PactInteraction {
	const found = pact.interactions.find(
		(candidate) =>
			candidate.request.method === method &&
			candidate.request.path === pathname,
	);
	if (found === undefined) {
		throw new Error(`no interaction for ${method} ${pathname}`);
	}
	return found;
}

/** Replays the contract: an unlisted request is a contract violation. */
const transport: VercelTransport = {
	async request(request) {
		const url = new URL(request.url);
		const found = interaction(request.method, url.pathname);
		const response: TransportResponse = {
			status: found.response.status,
			headers: {},
			body: JSON.stringify(found.response.body ?? null),
		};
		return response;
	},
};

function credential(): SponsoringCredential {
	return {
		token: new SecretValue(
			parseSecretRef("hobo-token://vercel/sponsor/contract"),
			"FAKE-sponsor-token-000000000000",
		),
		sponsorAccountId: SPONSOR_ACCOUNT,
		tokenId: "FAKEtokenid0000000000000",
	};
}

describe("VercelProjectTransferApi pact (consumer contract)", () => {
	it("names the boundary and pins it to the official REST origin", () => {
		expect(pact.consumer.name).toBe("@hobo/provider-vercel");
		expect(pact.provider.name).toBe("VercelProjectTransferApi");
		expect(pact.metadata.boundary.allowedHosts).toEqual(["api.vercel.com"]);
	});

	it("carries no credential material: every authorization header and code is a placeholder", () => {
		const serialized = JSON.stringify(pact);
		for (const bearer of serialized.matchAll(/"Bearer ([^"]+)"/gu)) {
			expect(bearer[1]).toMatch(/^<redacted-[a-z-]+>$/u);
		}
		expect(serialized).not.toMatch(/[?&]code=/u);
		expect(
			interaction("POST", "/projects/prj-sponsored-demo/transfer-request")
				.response.body?.code,
		).toBe("<redacted-transfer-code>");
	});

	it("seals the returned transfer code and derives the documented 24 hour deadline", async () => {
		const issuedAt = Date.UTC(2026, 7, 8);
		const request = await createProjectTransferRequest(
			transport,
			credential(),
			{ projectId: "prj-sponsored-demo", issuedAt },
		);

		expect(request.expiresAt).toBe(issuedAt + PROJECT_TRANSFER_CODE_TTL_MS);
		expect(JSON.stringify(request)).not.toContain("<redacted-transfer-code>");
		expect(request.code.expose()).toBe("<redacted-transfer-code>");
	});

	it("reads accountId as the ownership fact, before and after the transfer", async () => {
		const sponsored = await getProject(transport, credential(), {
			projectId: "prj-sponsored-demo",
		});
		expect(sponsored.accountId).toBe(SPONSOR_ACCOUNT);

		expect(
			await observeOrAdoptProject(transport, credential(), {
				projectId: "prj-sponsored-demo",
			}),
		).toEqual({ state: "owned-by-sponsor", accountId: SPONSOR_ACCOUNT });

		expect(
			await observeOrAdoptProject(transport, credential(), {
				projectId: "prj-claimed-demo",
			}),
		).toEqual({ state: "already-transferred", accountId: "team-claiming" });
	});

	it("treats a forbidden read as unreachable-by-sponsor rather than a failure", async () => {
		expect(
			await observeOrAdoptProject(transport, credential(), {
				projectId: "prj-unreachable-demo",
			}),
		).toEqual({ state: "unreachable-by-sponsor" });
	});

	it("fails closed when the project response drops the documented accountId", async () => {
		let caught: unknown;
		try {
			await getProject(transport, credential(), {
				projectId: "prj-contract-drift",
			});
		} catch (error) {
			caught = error;
		}
		expect(isVercelProviderError(caught)).toBe(true);
		expect(isVercelProviderError(caught) && caught.code).toBe(
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("revokes a pre-claim token, and counts an already-gone token as revoked", async () => {
		expect(
			await revokeSponsoringToken(transport, credential(), {
				tokenId: "token-sponsor-deploy",
			}),
		).toEqual({ tokenId: "token-sponsor-deploy", alreadyGone: false });

		expect(
			await revokeSponsoringToken(transport, credential(), {
				tokenId: "token-already-revoked",
			}),
		).toEqual({ tokenId: "token-already-revoked", alreadyGone: true });
	});
});
