import { describe, expect, it } from "vitest";

import { PrismaProviderError } from "../src/errors.js";
import { parseJsonObject } from "../src/json.js";
import { parseCreateDbHumanV1, parseCreateDbJson } from "../src/output.js";
import { fixture } from "./harness.js";

describe("parseCreateDbJson", () => {
	it("parses the pinned CLI's success document", () => {
		const result = parseCreateDbJson(fixture("create.success.json"));
		expect(result.projectId).toBe("proj_fake000000000000");
		expect(result.region).toBe("us-east-1");
		expect(result.outputMode).toBe("json");
		expect(result.deletionDateIso).toBe("2026-08-09T13:00:00.000Z");
	});

	it("labels the expiry as CLI-local, because the CLI computes it from its own clock", () => {
		const result = parseCreateDbJson(fixture("create.success.json"));
		expect(result.expirySource).toBe("cli-local-clock");
	});

	it("maps a rate-limit document to PROVIDER_RATE_LIMITED with the retry hint", () => {
		try {
			parseCreateDbJson(fixture("create.rate-limited.json"));
			expect.unreachable("a rate-limit document must throw");
		} catch (error) {
			if (!(error instanceof PrismaProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_RATE_LIMITED");
			expect(error.retryable).toBe(true);
			expect(error.retryAfterMs).toBe(60_000);
		}
	});

	it("maps an upstream 5xx to PROVIDER_OPERATION_AMBIGUOUS", () => {
		try {
			parseCreateDbJson(fixture("create.api-error-500.json"));
			expect.unreachable("an upstream 5xx must throw");
		} catch (error) {
			if (!(error instanceof PrismaProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
		}
	});

	it("fails closed on malformed JSON without echoing the credential", () => {
		try {
			parseCreateDbJson(fixture("create.malformed.txt"));
			expect.unreachable("malformed JSON must throw");
		} catch (error) {
			if (!(error instanceof PrismaProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
			expect(JSON.stringify(error.toJSON())).not.toContain("postgresql://");
		}
	});

	it("fails closed when the CLI renames its fields", () => {
		expect(() =>
			parseCreateDbJson(fixture("create.renamed-fields.json")),
		).toThrowError(/missing the string field `claimUrl`/u);
	});

	it("rejects a project id that is not a proj_ identifier", () => {
		const body = {
			...parseJsonObject(fixture("create.success.json")),
			projectId: "../../admin",
		};
		expect(() => parseCreateDbJson(JSON.stringify(body))).toThrowError(
			/`proj_…` identifier/u,
		);
	});

	it("rejects trailing output after the JSON document", () => {
		expect(() =>
			parseCreateDbJson(
				`${fixture("create.success.json")}\nAnalytics flushed.`,
			),
		).toThrowError(/single JSON document/u);
	});
});

describe("parseCreateDbHumanV1", () => {
	it("reads the documented pretty output by label", () => {
		const result = parseCreateDbHumanV1(fixture("create.human.txt"), {
			region: "us-east-1",
		});
		expect(result.projectId).toBe("proj_fake000000000000");
		expect(result.connectionString).toContain("db.prisma.io");
		expect(result.outputMode).toBe("human-v1");
		expect(result.deletionDateIso).toBe("2026-08-09T13:00:00.000Z");
	});

	it("reads the locale-formatted deletion sentence the docs show", () => {
		const text = fixture("create.human.txt").replace(
			"2026-08-09T13:00:00.000Z if not claimed",
			"7/24/2025, 2:25:41 AM if not claimed",
		);
		const result = parseCreateDbHumanV1(text, { region: "us-east-1" });
		expect(Number.isFinite(result.deletionDateMs)).toBe(true);
	});

	it("refuses to guess when the connection label is missing", () => {
		const text = fixture("create.human.txt").replace(
			"Connection String:",
			"Connection details:",
		);
		expect(() =>
			parseCreateDbHumanV1(text, { region: "us-east-1" }),
		).toThrowError(/exactly one "Connection String:" label, found 0/u);
	});

	it("refuses an ambiguous output with two connection labels", () => {
		const text = `${fixture("create.human.txt")}\n│    Connection String:\n│    postgresql://other:REDACTED@db.prisma.io:5432/postgres\n`;
		expect(() =>
			parseCreateDbHumanV1(text, { region: "us-east-1" }),
		).toThrowError(/found 2/u);
	});

	it("does not scrape a URI from anywhere in the text", () => {
		const text = fixture("create.human.txt")
			.replace("Connection String:", "Connection details:")
			.concat(
				"\nnote: postgresql://attacker:REDACTED@db.prisma.io:5432/postgres\n",
			);
		expect(() =>
			parseCreateDbHumanV1(text, { region: "us-east-1" }),
		).toThrowError(/Connection String:/u);
	});

	it("requires the claim URL to be the official one", () => {
		// Prefix matching would accept this host. Only host equality rejects it.
		const text = fixture("create.human.txt").replace(
			"https://create-db.prisma.io?",
			"https://create-db.prisma.io.attacker.example?",
		);
		expect(() =>
			parseCreateDbHumanV1(text, { region: "us-east-1" }),
		).toThrowError(/exactly one create-db\.prisma\.io claim URL, found 0/u);
	});

	it("refuses output with no deletion sentence", () => {
		const text = fixture("create.human.txt").replace(
			"will be deleted on",
			"expires around",
		);
		expect(() =>
			parseCreateDbHumanV1(text, { region: "us-east-1" }),
		).toThrowError(/will be deleted on/u);
	});
});
