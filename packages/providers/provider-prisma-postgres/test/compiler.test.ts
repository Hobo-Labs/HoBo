/**
 * The compiler is pure, and these tests are what make that claim checkable.
 */
import { describe, expect, it } from "vitest";

import { PINNED_CREATE_DB_SPECIFIER } from "../src/cli.js";
import { compilePrismaProvision } from "../src/compiler.js";
import type { PrismaProviderError } from "../src/errors.js";

const REQUIREMENT = {
	requiredProfiles: [{ profileId: "data.postgres/v1", versionRange: ">=1" }],
} as const;

const PLACEMENT = {
	region: "eu-central-1",
	resourceRef: "hobo://camp/dev/bindle/app-db",
	idempotencyKey: "hobo-prisma-compile-0001",
} as const;

describe("compilePrismaProvision", () => {
	it("produces the operation, with the literal argv a reviewer can read", () => {
		const operation = compilePrismaProvision(REQUIREMENT, PLACEMENT);

		expect(operation.kind).toBe("provision");
		expect(operation.definitionId).toBe("prisma.claimable-postgres/v1");
		expect(operation.providerId).toBe("prisma");
		expect(operation.bootstrapStrategyRef).toBe(
			"bootstrap.prisma.create-db/v1",
		);
		expect(operation.claimStrategyRef).toBe("claim.prisma.database/v1");
		expect(operation.argv).toEqual([
			"npx",
			"--yes",
			PINNED_CREATE_DB_SPECIFIER,
			"create",
			"--json",
			"--region=eu-central-1",
		]);
	});

	it("is deterministic: same inputs, deeply equal operation", () => {
		const first = compilePrismaProvision(REQUIREMENT, PLACEMENT);
		const second = compilePrismaProvision(REQUIREMENT, PLACEMENT);
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("reads no clock: the operation carries no timestamp at all", () => {
		const operation = compilePrismaProvision(REQUIREMENT, PLACEMENT);
		const serialized = JSON.stringify(operation);
		expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
		expect(serialized).not.toMatch(/\b1[6-9]\d{11}\b/u);
	});

	it("never resolves `latest` into the plan", () => {
		const operation = compilePrismaProvision(REQUIREMENT, PLACEMENT);
		expect(operation.argv.join(" ")).not.toContain("@latest");
		expect(operation.argv).toContain(PINNED_CREATE_DB_SPECIFIER);
	});

	it("passes a requested TTL through as one fused argv element", () => {
		const operation = compilePrismaProvision(REQUIREMENT, {
			...PLACEMENT,
			ttl: "2h",
		});
		expect(operation.requestedTtl).toBe("2h");
		expect(operation.argv).toContain("--ttl=2h");
	});

	it("compiles a data.relational/v1 requirement, which Postgres refines", () => {
		const operation = compilePrismaProvision(
			{
				requiredProfiles: [
					{ profileId: "data.relational/v1", versionRange: ">=1" },
				],
			},
			PLACEMENT,
		);
		expect(operation.region).toBe("eu-central-1");
	});

	it("refuses a profile this product does not implement", () => {
		expect(() =>
			compilePrismaProvision(
				{
					requiredProfiles: [
						{ profileId: "data.sqlite/v1", versionRange: ">=1" },
					],
				},
				PLACEMENT,
			),
		).toThrowError(/does not implement data\.sqlite\/v1/u);
	});

	it("refuses a required feature the temporary tier documents nothing about", () => {
		try {
			compilePrismaProvision(
				{ ...REQUIREMENT, requiredFeatures: { extensions: ["vector"] } },
				PLACEMENT,
			);
			expect.unreachable("an undocumented required feature must not compile");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).message).toContain("`extensions`");
		}
	});

	it("refuses a region the pinned CLI does not accept", () => {
		expect(() =>
			compilePrismaProvision(REQUIREMENT, {
				...PLACEMENT,
				// SAFETY: value was established by the surrounding parse or typed constructor.
				region: "us-east-2" as never,
			}),
		).toThrowError(/not one the pinned create-db CLI accepts/u);
	});

	it("refuses a TTL outside the documented 30m-24h range", () => {
		expect(() =>
			compilePrismaProvision(REQUIREMENT, { ...PLACEMENT, ttl: "72h" }),
		).toThrowError(/not one of 30m or 1h-24h/u);
	});

	it("refuses a malformed idempotency key before anything can run", () => {
		expect(() =>
			compilePrismaProvision(REQUIREMENT, {
				...PLACEMENT,
				idempotencyKey: "short",
			}),
		).toThrowError(/idempotencyKey/u);
	});

	it("keeps shell metacharacters out of every argv element", () => {
		const operation = compilePrismaProvision(REQUIREMENT, {
			...PLACEMENT,
			userAgent: "hobo-planner",
		});
		for (const element of operation.argv) {
			expect(element).not.toMatch(/[;&|`$><\n\r\t\0'"\\]/u);
			expect(element).not.toMatch(/\s/u);
		}
	});

	it("refuses a hostile user agent rather than escaping it", () => {
		expect(() =>
			compilePrismaProvision(REQUIREMENT, {
				...PLACEMENT,
				userAgent: "hobo`id`",
			}),
		).toThrowError(/user agent/u);
	});
});
