/**
 * The package's one pact says it owns no service boundary: a test links the
 * harness and calls it in-process. These pin that the pact parses and the
 * inventory lists it.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkPactInventory, parsePactDocument } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";

const contracts = fileURLToPath(new URL("../contracts", import.meta.url));

describe("the redaction-test-harness pact", () => {
	it("is listed in the inventory", async () => {
		expect(await checkPactInventory(contracts)).toEqual({
			ok: true,
			problems: [],
		});
	});

	it("records an in-process library with no service boundary", async () => {
		const pact = parsePactDocument(
			JSON.parse(
				await readFile(
					`${contracts}/pacts/redaction-test-harness-boundary.pact.json`,
					"utf8",
				),
			),
		);
		expect(pact.provider.name).toBe("RedactionTestHarnessPackage");
		expect(pact.interactions[0]?.response.body).toEqual({
			ownsServiceBoundary: false,
		});
	});
});
