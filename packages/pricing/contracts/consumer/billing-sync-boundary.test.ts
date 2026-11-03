import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../../src/_generated/pricing_pb.js";
import { isJsonObject, parseJson, type JsonValue } from "../../src/json.js";
import {
	fixtureProviderPort,
	runBillingSync,
} from "../../src/sync/billing-sync.js";
import {
	createSyntheticProviderCredentials,
	parseFocusBillingRow,
} from "../../src/sync/provider-port.js";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
	if (!isJsonObject(value)) throw new Error("PACT value is not an object");
	return value;
}

const here = dirname(fileURLToPath(import.meta.url));
const pact = object(
	parseJson(
		readFileSync(join(here, "../pacts/provider-billing-sync.pact.json"), "utf8"),
	),
);

describe("pricing billing sync consumer boundary", () => {
	it("meets the billing sync PACT boundary", async () => {
		const interactions = pact.interactions;
		if (!Array.isArray(interactions))
			throw new Error("PACT interactions are missing");
		expect(interactions).toHaveLength(1);

		for (const value of interactions) {
			const interaction = object(value);
			const request = object(interaction.request);
			const response = object(interaction.response);
			expect(request.method).toBe("POST");
			expect(request.path).toBe("/pricing/v1/billing-sync");
			const body = object(request.body);
			const rows = body.rows;
			if (!Array.isArray(rows)) throw new Error("rows missing");
			const focusRows = rows.map((row) => {
				const parsed = parseFocusBillingRow(row);
				if (parsed === undefined) throw new Error("invalid FOCUS row in PACT");
				return parsed;
			});
			const quoted = object(body.quotedIncrementalBilled);
			const result = await runBillingSync({
				syncAt: String(body.syncAt),
				periodStart: String(body.periodStart),
				periodEnd: String(body.periodEnd),
				reservationId: String(body.reservationId),
				eventId: "evt-pact-billing-sync",
				quotedIncrementalBilled: create(MoneySchema, {
					decimal: String(quoted.decimal),
					currency: String(quoted.currency),
				}),
				port: fixtureProviderPort(focusRows),
				credentials: createSyntheticProviderCredentials(),
			});
			if ("code" in result) {
				throw new Error(`${result.code}: ${result.message}`);
			}
			const expected = object(response.body);
			expect(result.snapshot.schema).toBe(String(expected.schema));
			expect(result.snapshot.syncAt).toBe(String(expected.syncAt));
			expect(result.snapshot.completeness).toBe(String(expected.completeness));
			expect(result.snapshot.imported).toHaveLength(
				Number(expected.importedCount),
			);
			expect(result.reconciliation.reconciliationHash).toMatch(
				/^sha256:[0-9a-f]{64}$/,
			);
		}
	});
});
