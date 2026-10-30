import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaimableOperationKeyDeriver } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import { createPrismaClaimableDatabaseDriver } from "../src/driver.js";
import { isJsonObject, type JsonValue, parseJsonValue } from "../src/json.js";
import { toProviderFacts, toProvisionReceipt } from "../src/receipt.js";
import {
	createStubCustody,
	createStubRunner,
	FIXTURE_NOW_MS,
	fixture,
	stdout,
} from "./harness.js";

const cue = fileURLToPath(
	new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../data-models/provider_prisma_postgres.cue", import.meta.url),
);
function wire(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(wire);
	if (isJsonObject(value)) {
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value))
			result[key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)] =
				wire(entry);
		return result;
	}
	return value;
}
function vet(value: JsonValue, definition: string) {
	const folder = mkdtempSync(join(tmpdir(), "prisma-postgres-public-schema-"));
	try {
		const file = join(folder, "record.json");
		writeFileSync(file, JSON.stringify(wire(value)));
		execFileSync(cue, ["vet", "-c", "-d", definition, schema, file], {
			stdio: "pipe",
		});
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
async function example() {
	const custody = createStubCustody();
	const clock = () => FIXTURE_NOW_MS;
	const driver = createPrismaClaimableDatabaseDriver({
		client: createPrismaClient({
			runner: createStubRunner([stdout(fixture("create.success.json"))]),
			store: createInMemoryIdempotencyStore(),
			clock,
		}),
		custody,
		clock,
	});
	const record = await driver.provision({
		idempotencyKey: "public-schema-fixture",
		resourceRef: "hobo://database",
	});
	const options = {
		custody,
		deriveOperationKey: createClaimableOperationKeyDeriver(
			Uint8Array.from({ length: 32 }, (_, i) => i + 1),
		),
		scope: {
			tenantId: "tenant",
			providerAccountId: "anonymous",
			scopeId: "deployment",
		},
	};
	return {
		receipt: await toProvisionReceipt(record, options),
		facts: await toProviderFacts(record, options),
	};
}
describe("Prisma public projection CUE", () => {
	it("accepts actual shipped receipt and fact projections", async () => {
		const { receipt, facts } = await example();
		expect(() =>
			vet(parseJsonValue(JSON.stringify(receipt)), "#PrismaProvisionReceipt"),
		).not.toThrow();
		for (const fact of facts)
			expect(() =>
				vet(parseJsonValue(JSON.stringify(fact)), "#PrismaProviderFact"),
			).not.toThrow();
	});
	it("rejects legacy native identities and plaintext claim URLs", async () => {
		const { receipt } = await example();
		expect(() =>
			vet(
				parseJsonValue(
					JSON.stringify({ ...receipt, projectId: "private-native-id" }),
				),
				"#PrismaProvisionReceipt",
			),
		).toThrow();
		expect(() =>
			vet(
				parseJsonValue(
					JSON.stringify({
						...receipt,
						claim: {
							...receipt.claim,
							claimRef: "https://provider.example/claim/private",
						},
					}),
				),
				"#PrismaProvisionReceipt",
			),
		).toThrow();
	});
});
