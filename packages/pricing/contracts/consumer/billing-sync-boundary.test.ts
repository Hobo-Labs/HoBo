import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../../src/_generated/pricing_pb.js";
import { isJsonObject, type JsonValue, parseJson } from "../../src/json.js";
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
		readFileSync(
			join(here, "../pacts/provider-billing-sync.pact.json"),
			"utf8",
		),
	),
);

async function executeRequest(value: JsonValue) {
	const body = object(value);
	const rows = body.rows;
	if (!Array.isArray(rows)) throw new Error("rows missing");
	const focusRows = rows.map((row) => {
		const parsed = parseFocusBillingRow(row);
		if (parsed === undefined) throw new Error("invalid FOCUS row in PACT");
		return parsed;
	});
	const quoted = object(body.quotedIncrementalBilled);
	return runBillingSync({
		syncAt: String(body.syncAt),
		periodStart: String(body.periodStart),
		periodEnd: String(body.periodEnd),
		reservationId: String(body.reservationId),
		eventId: String(body.eventId),
		quotedIncrementalBilled: create(MoneySchema, {
			decimal: String(quoted.decimal),
			currency: String(quoted.currency),
		}),
		port: fixtureProviderPort(focusRows),
		credentials: createSyntheticProviderCredentials(),
	});
}

describe("pricing billing sync consumer boundary", () => {
	it("meets the billing sync PACT boundary", async () => {
		const interactions = pact.interactions;
		if (!Array.isArray(interactions))
			throw new Error("PACT interactions are missing");
		expect(interactions).toHaveLength(2);

		for (const value of interactions) {
			const interaction = object(value);
			expect(interaction.type).toBe("Synchronous/Messages");
			const request = object(object(interaction.request).contents);
			expect(request.contentType).toBe("application/json");
			expect(request.encoded).toBe(false);
			const responses = interaction.response;
			if (!Array.isArray(responses) || responses.length !== 1)
				throw new Error("PACT response is missing");
			const response = object(object(responses[0]).contents);
			expect(response.contentType).toBe("application/json");
			expect(response.encoded).toBe(false);
			const result = await executeRequest(object(request.content));
			expect(result).toMatchObject(object(response.content));
		}
	});

	it("verifies recorded requests with the Pact provider verifier", async () => {
		const interactions = pact.interactions;
		if (!Array.isArray(interactions))
			throw new Error("PACT interactions missing");
		const descriptions = interactions.map((value) => {
			const description = String(object(value).description ?? "");
			if (!description) throw new Error("description missing");
			return description;
		});
		const verified = new Set<string>();
		const invoke = (message: MessageDescriptor) => {
			if (message.content === undefined || Buffer.isBuffer(message.content))
				throw new Error("invalid billing contract request");
			verified.add(message.description);
			return executeRequest(parseJson(JSON.stringify(message.content)));
		};
		const messageProviders = Object.fromEntries(
			descriptions.map((description) => [description, invoke]),
		);
		await new Verifier({
			provider: "hobo-pricing-billing-sync-adapter",
			pactUrls: [join(here, "../pacts/provider-billing-sync.pact.json")],
			messageProviders,
			logLevel: "error",
			failIfNoPactsFound: true,
		}).verifyProvider();
		expect([...verified].sort()).toEqual(descriptions.sort());
	}, 30_000);
});
