import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createUpstashClient,
} from "../src/client.js";
import { createUpstashTemporaryRedisDriver } from "../src/driver.js";
import { isJsonObject, type JsonValue, parseJsonValue } from "../src/json.js";
import { toProviderFacts, toProvisionReceipt } from "../src/receipt.js";
import {
	createStubCustody,
	createStubTransport,
	FAKE_DATABASE_ID,
	FIXTURE_CREATED_AT_MS,
} from "./fixtures/index.js";
import { publicOptions } from "./public-serialization.js";

const cue = fileURLToPath(
	new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../data-models/temporary_redis.cue", import.meta.url),
);
function snake(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(snake);
	if (isJsonObject(value)) {
		const mapped: { [key: string]: JsonValue } = {};
		for (const [key, entry] of Object.entries(value))
			mapped[
				key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)
			] = snake(entry);
		return mapped;
	}
	return value;
}
function vet(definition: string, value: JsonValue) {
	const folder = mkdtempSync(join(tmpdir(), "upstash-public-receipt-"));
	try {
		const input = join(folder, "record.json");
		writeFileSync(input, JSON.stringify(value));
		execFileSync(cue, ["vet", "-c", "-d", definition, schema, input], {
			stdio: "pipe",
		});
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

describe("custodial public receipt and fact CUE boundaries", () => {
	it("accepts actual safe serializer output and rejects raw legacy native identities/claim URLs", async () => {
		const clock = () => FIXTURE_CREATED_AT_MS;
		const driver = createUpstashTemporaryRedisDriver({
			client: createUpstashClient({
				transport: createStubTransport({}),
				store: createInMemoryIdempotencyStore(),
				clock,
			}),
			custody: createStubCustody(),
			clock,
		});
		const record = await driver.provision({
			resourceRef: "logical-cache",
			idempotencyKey: FAKE_DATABASE_ID,
		});
		const receipt = snake(
			parseJsonValue(
				JSON.stringify(await toProvisionReceipt(record, publicOptions())),
			),
		);
		expect(() => vet("#UpstashProvisionReceipt", receipt)).not.toThrow();
		if (!isJsonObject(receipt))
			throw new Error("receipt serializer must emit an object");
		expect(() =>
			vet("#UpstashProvisionReceipt", {
				...receipt,
				database_id: FAKE_DATABASE_ID,
			}),
		).toThrow();
		expect(() =>
			vet("#UpstashProvisionReceipt", {
				...receipt,
				resource_ref: FAKE_DATABASE_ID,
			}),
		).toThrow();
		expect(() =>
			vet("#UpstashProvisionReceipt", {
				...receipt,
				claim: {
					state: "unclaimed",
					boundary: "resource",
					atomicity: "single-resource",
					claim_url: record.claim.claimUrl,
					blocking_action_ids: [],
				},
			}),
		).toThrow();
		for (const fact of await toProviderFacts(record, publicOptions()))
			expect(() =>
				vet(
					"#UpstashProviderFact",
					snake(parseJsonValue(JSON.stringify(fact))),
				),
			).not.toThrow();
	});
});
