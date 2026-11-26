import { describe, expect, it } from "vitest";

import { parseNeonDatabaseResponse } from "../src/api.js";
import { NeonProviderError } from "../src/errors.js";
import { parseJsonObject } from "../src/json.js";
import { fixture } from "./harness.js";

describe("parseNeonDatabaseResponse", () => {
	it("parses the documented create response", () => {
		const parsed = parseNeonDatabaseResponse(
			fixture("create-database.unclaimed.json"),
		);
		expect(parsed.databaseId).toBe("01999999-0000-7000-8000-000000000001");
		expect(parsed.status).toBe("UNCLAIMED");
		expect(parsed.neonProjectId).toBe("fake-project-00000000");
		expect(parsed.claimUrl).toBe(
			"https://neon.new/claim/01999999-0000-7000-8000-000000000001",
		);
	});

	it("takes expiry from the provider timestamp rather than a local 72h timer", () => {
		const parsed = parseNeonDatabaseResponse(
			fixture("create-database.unclaimed.json"),
		);
		expect(parsed.expiresAtIso).toBe("2026-08-11T12:00:00.000Z");
		expect(parsed.expiresAtMs).toBe(Date.parse("2026-08-11T12:00:00.000Z"));
		// Provider-reported, not created_at + 72h — those coincide in this
		// fixture only because Neon's current default happens to be 72h.
		expect(parsed.expiresAtMs).not.toBe(Date.now() + 72 * 60 * 60 * 1000);
	});

	it("reports a null connection string once the database is claimed", () => {
		const parsed = parseNeonDatabaseResponse(
			fixture("get-database.claimed.json"),
		);
		expect(parsed.status).toBe("CLAIMED");
		expect(parsed.connectionString).toBeNull();
	});

	it("fails closed on an unknown status rather than guessing", () => {
		expect(() =>
			parseNeonDatabaseResponse(fixture("create-database.unknown-status.json")),
		).toThrowError(NeonProviderError);
		try {
			parseNeonDatabaseResponse(fixture("create-database.unknown-status.json"));
		} catch (error) {
			if (!(error instanceof NeonProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("rejects the documented error envelope", () => {
		try {
			parseNeonDatabaseResponse(fixture("error-missing-ref.json"));
			expect.unreachable("error envelope must not parse as a database");
		} catch (error) {
			if (!(error instanceof NeonProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("rejects a claim_url pointing somewhere other than an official host", () => {
		const body = {
			...parseJsonObject(fixture("create-database.unclaimed.json")),
			claim_url: "https://neon.new.attacker.example/claim/x",
		};
		expect(() => parseNeonDatabaseResponse(JSON.stringify(body))).toThrowError(
			/official Neon host/u,
		);
	});

	it("never echoes the connection string when the body is unparseable", () => {
		const body =
			'postgresql://neondb_owner:REDACTED@ep-fake-000000.us-east-2.aws.neon.tech/db{"';
		try {
			parseNeonDatabaseResponse(body);
			expect.unreachable("malformed JSON must throw");
		} catch (error) {
			if (!(error instanceof NeonProviderError)) throw error;
			expect(JSON.stringify(error.detail)).not.toContain("postgresql://");
		}
	});
});
