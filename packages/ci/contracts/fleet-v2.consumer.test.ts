import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("strict fleet store pact", () => {
	it("documents the reserve-capacity boundary", () => {
		const pact = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../contracts/fleet-v2.pact.json"),
				"utf8",
			),
		);
		expect(pact.consumer.name).toBe("@hobo/ci");
		expect(pact.interactions).toHaveLength(1);
	});
});
