/**
 * Consumer-driven contract verification for the registry read boundary.
 *
 * `contracts/provider-ttl-sh-registry.pact.json` states what this package
 * expects of ttl.sh. A pact nobody replays is a wish, so this suite loads it
 * and drives the real guarded transport against every interaction: the request
 * the driver emits must be one the pact describes, and the driver must behave
 * as documented when handed the pact's recorded response.
 *
 * Only the consumer half is verifiable here. Nobody can verify ttl.sh's half
 * offline, and no test in this package touches the network. What the file does
 * instead is pin what this driver sends and record — with a dated source ref —
 * what a human last observed coming back, so the next re-check is a diff.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { ttlShErrorForStatus } from "../src/errors.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
import { createTtlShImageReference, manifestPath } from "../src/reference.js";
import {
	createGuardedTransport,
	FORBIDDEN_REQUEST_HEADERS,
	TTL_SH_REGISTRY_POLICY,
} from "../src/transport.js";
import {
	createStubTransport,
	FAKE_UUID_NAME,
	rejectTtlShCode,
} from "./fixtures/index.js";

type PactHeaders = { readonly [key: string]: string };

type PactInteraction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly headers: PactHeaders;
	};
	readonly response: {
		readonly status: number;
		readonly headers: PactHeaders;
		readonly body: JsonValue | undefined;
	};
};

type PactFile = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly metadata: {
		readonly pactSpecification: { readonly version: string };
		readonly sourceRefs: readonly {
			readonly url: string;
			readonly checkedAt: string;
		}[];
	};
	readonly interactions: readonly PactInteraction[];
};

function jsonStringMap(value: JsonValue | undefined) {
	if (!isJsonObject(value)) return {};
	const mapped: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonString(entry)) mapped[key] = entry;
	}
	return mapped;
}

function parseSourceRefs(value: JsonValue | undefined) {
	if (!isJsonArray(value)) return [];
	const refs: { url: string; checkedAt: string }[] = [];
	for (const entry of value) {
		if (
			!isJsonObject(entry) ||
			!isJsonString(entry.url) ||
			!isJsonString(entry.checkedAt)
		) {
			continue;
		}
		refs.push({ url: entry.url, checkedAt: entry.checkedAt });
	}
	return refs;
}

function parseInteraction(entry: JsonObject): PactInteraction | undefined {
	const request = isJsonObject(entry.request) ? entry.request : undefined;
	const response = isJsonObject(entry.response) ? entry.response : undefined;
	if (
		!isJsonString(entry.description) ||
		request === undefined ||
		response === undefined ||
		!isJsonString(request.method) ||
		!isJsonString(request.path) ||
		!isJsonNumber(response.status)
	) {
		return undefined;
	}
	return {
		description: entry.description,
		request: {
			method: request.method,
			path: request.path,
			headers: jsonStringMap(request.headers),
		},
		response: {
			status: response.status,
			headers: jsonStringMap(response.headers),
			body: response.body,
		},
	};
}

/**
 * Parse the pact rather than trusting its shape.
 *
 * The file is checked-in JSON, so this is a legibility boundary rather than a
 * security one: a suite that fails with "cannot read property of undefined"
 * three assertions later is worse than one that says the pact is malformed.
 */
function loadPact(): PactFile {
	const decoded = parseJsonObject(
		readFileSync(
			fileURLToPath(
				new URL(
					"../contracts/provider-ttl-sh-registry.pact.json",
					import.meta.url,
				),
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
	const spec = isJsonObject(metadata?.pactSpecification)
		? metadata.pactSpecification
		: undefined;
	const interactionsRaw = decoded.interactions;
	if (
		!isJsonString(consumer?.name) ||
		!isJsonString(provider?.name) ||
		!isJsonString(spec?.version) ||
		metadata === undefined ||
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
			pactSpecification: { version: spec.version },
			sourceRefs: parseSourceRefs(metadata.sourceRefs),
		},
		interactions,
	};
}

const PACT = loadPact();

function interactionMatching(fragment: string): PactInteraction {
	const found = PACT.interactions.find((interaction) =>
		interaction.description.includes(fragment),
	);
	assert.ok(found !== undefined, `no interaction describing ${fragment}`);
	return found;
}

function bodyOf(interaction: PactInteraction): string {
	const body = interaction.response.body;
	if (body === undefined) return "";
	return isJsonString(body) ? body : JSON.stringify(body);
}

async function replay(interaction: PactInteraction) {
	const transport = createGuardedTransport(
		createStubTransport({
			script: [
				{
					status: interaction.response.status,
					headers: Object.fromEntries(
						Object.entries(interaction.response.headers ?? {}).map(
							([name, value]) => [name.toLowerCase(), value],
						),
					),
					body: bodyOf(interaction),
				},
			],
		}),
	);
	return transport.request({
		method: interaction.request.method === "HEAD" ? "HEAD" : "GET",
		url: `https://ttl.sh${interaction.request.path}`,
		headers: interaction.request.headers ?? {},
		timeoutMs: 5_000,
		maxResponseBytes: TTL_SH_REGISTRY_POLICY.maxResponseBytes,
	});
}

describe("the pact describes the boundary this package actually has", () => {
	it("names this package as the consumer and ttl.sh as the provider", () => {
		assert.equal(PACT.consumer.name, "@hobo/provider-ttl-sh");
		assert.equal(PACT.provider.name, "TtlShEphemeralRegistry");
		assert.equal(PACT.metadata.pactSpecification.version, "3.0.0");
	});

	it("dates every source a fact was read from", () => {
		assert.ok(PACT.metadata.sourceRefs.length > 0);
		for (const source of PACT.metadata.sourceRefs) {
			assert.match(source.url, /^https:\/\//u);
			assert.match(source.checkedAt, /^\d{4}-\d{2}-\d{2}$/u);
		}
	});

	it("stays entirely within the allowlisted /v2/ surface", () => {
		for (const interaction of PACT.interactions) {
			assert.ok(
				interaction.request.path.startsWith(
					TTL_SH_REGISTRY_POLICY.allowedPathPrefix,
				),
				`${interaction.description} leaves the allowlisted prefix`,
			);
		}
	});

	it("carries no credential in any recorded request", () => {
		// The registry is anonymous. A pact that recorded an Authorization
		// header would be documenting a leak as if it were the contract.
		for (const interaction of PACT.interactions) {
			for (const name of Object.keys(interaction.request.headers)) {
				let forbidden = false;
				for (const header of FORBIDDEN_REQUEST_HEADERS) {
					if (header === name.toLowerCase()) forbidden = true;
				}
				assert.equal(
					forbidden,
					false,
					`${interaction.description} sends ${name}`,
				);
			}
		}
	});

	it("uses artifact names this package would actually mint", () => {
		for (const interaction of PACT.interactions) {
			const name = /^\/v2\/([^/]+)\//u.exec(interaction.request.path)?.[1];
			if (name === undefined) continue;
			assert.equal(name, FAKE_UUID_NAME);
		}
	});
});

describe("replaying each interaction through the guarded transport", () => {
	it("emits exactly the manifest path the pact records", () => {
		const reference = createTtlShImageReference({
			name: FAKE_UUID_NAME,
			ttl: "1h",
		});
		assert.equal(
			manifestPath(reference),
			interactionMatching("live ephemeral artifact").request.path,
		);
	});

	it("accepts the anonymous /v2/ probe", async () => {
		const response = await replay(
			interactionMatching("probe the distribution API"),
		);
		assert.equal(response.status, 200);
		assert.equal(
			response.headers["docker-distribution-api-version"],
			"registry/2.0",
		);
	});

	it("accepts a live manifest and keeps the digest the registry reported", async () => {
		const response = await replay(
			interactionMatching("live ephemeral artifact"),
		);
		assert.equal(response.status, 200);
		assert.match(
			response.headers["docker-content-digest"] ?? "",
			/^sha256:[0-9a-f]{64}$/u,
		);
		const manifest = parseJsonObject(response.body);
		assert.equal(manifest.schemaVersion, 2);
	});

	it("turns the elapsed-TTL 404 into an expired lease rather than a retry", async () => {
		const interaction = interactionMatching("TTL has elapsed");
		const response = await replay(interaction);
		assert.equal(response.status, 404);

		const error = ttlShErrorForStatus(response.status, { method: "GET" });
		assert.equal(error.code, "LEASE_EXPIRED");
		// Retrying a reaped artifact just spends time; the fix is a new push.
		assert.equal(error.retryable, false);
	});

	it("maps the recorded 429 to a retryable rate limit carrying Retry-After", async () => {
		const interaction = interactionMatching("rate-limited read");
		const response = await replay(interaction);
		const retryAfterSeconds = Number(response.headers["retry-after"]);
		assert.equal(retryAfterSeconds, 30);

		const error = ttlShErrorForStatus(response.status, {
			method: "GET",
			retryAfterMs: retryAfterSeconds * 1000,
		});
		assert.equal(error.code, "PROVIDER_RATE_LIMITED");
		assert.equal(error.retryable, true);
		assert.equal(error.retryAfterMs, 30_000);
	});

	it("treats the recorded authentication challenge as a contract change", async () => {
		await rejectTtlShCode(
			() => replay(interactionMatching("authentication challenge")),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses the recorded redirect instead of following it off the host", async () => {
		const error = await rejectTtlShCode(
			() => replay(interactionMatching("redirect off the allowlisted host")),
			"PROVIDER_CONTRACT_CHANGED",
		);
		assert.equal(
			String(error.detail.location).includes("mirror.example.com"),
			true,
		);
	});
});
