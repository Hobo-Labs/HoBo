/**
 * Verify this package against its own consumer-driven boundary contract.
 *
 * The provider is a child process, so the contract is over argv, environment,
 * exit code, and the stdout document. Checking it here is what keeps
 * `contracts/create-db-cli-boundary.contract.json` from drifting into
 * decoration.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createDbEnv } from "../src/cli.js";
import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import type { PrismaProviderError } from "../src/errors.js";
import { parseCreateDbHumanV1, parseCreateDbJson } from "../src/output.js";
import {
	createStubRunner,
	FIXTURE_NOW_MS,
	fixedClock,
	fixture,
} from "./harness.js";

type Interaction = {
	readonly description: string;
	readonly request: {
		readonly argv: readonly string[];
		readonly timeoutMs?: number;
	};
	readonly response: {
		readonly code: number;
		readonly stdout?: string;
		readonly stdoutFixture?: string;
		readonly mapsToHoboCode?: string;
		readonly parsedBy?: string;
	};
};

// SAFETY: value was established by the surrounding parse or typed constructor.
const contract = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/create-db-cli-boundary.contract.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as {
	readonly provider: {
		readonly specifier: string;
		readonly pinnedVersion: string;
	};
	readonly environment: readonly string[];
	readonly interactions: readonly Interaction[];
};

function interaction(description: string): Interaction {
	const found = contract.interactions.find(
		(item) => item.description === description,
	);
	if (found === undefined)
		throw new Error(`no contract interaction named ${description}`);
	return found;
}

function stdoutFor(item: Interaction): string {
	return item.response.stdoutFixture !== undefined
		? fixture(item.response.stdoutFixture)
		: (item.response.stdout ?? "");
}

async function runAgainst(
	item: Interaction,
	outputMode: "json" | "human-v1" = "json",
) {
	const runner = createStubRunner([
		{ code: item.response.code, stdout: stdoutFor(item), stderr: "" },
	]);
	const client = createPrismaClient({
		runner,
		store: createInMemoryIdempotencyStore(),
		clock: fixedClock(FIXTURE_NOW_MS),
		outputMode,
		...(item.request.argv.includes("--region=eu-central-1")
			? { invocation: { region: "eu-central-1" as const } }
			: undefined),
	});
	return { runner, client };
}

describe("create-db process boundary contract", () => {
	it("pins the exact version the contract was written against", () => {
		expect(contract.provider.specifier).toBe(
			`create-db@${contract.provider.pinnedVersion}`,
		);
		expect(contract.provider.pinnedVersion).not.toBe("latest");
	});

	it("passes only the environment keys the contract declares", () => {
		expect(Object.keys(createDbEnv()).sort()).toEqual(
			[...contract.environment].sort(),
		);
	});

	for (const description of [
		"create a temporary database and ask for the machine-readable document",
		"create in a documented region, as one fused argv element",
	]) {
		it(`emits the contracted argv: ${description}`, async () => {
			const item = interaction(description);
			const { runner, client } = await runAgainst(item);
			await client.create({ idempotencyKey: "hobo-prisma-contract-01" });
			expect(runner.runs[0]?.argv).toEqual(item.request.argv);
			if (item.request.timeoutMs !== undefined) {
				expect(runner.runs[0]?.options.timeoutMs).toBe(item.request.timeoutMs);
			}
		});
	}

	for (const description of [
		"rate limited by the create-db worker",
		"upstream 5xx: the CLI reached the service, so a create may or may not have happened",
		"the CLI dies without printing a document",
	]) {
		it(`maps the failure to its contracted HoBo code: ${description}`, async () => {
			const item = interaction(description);
			const { client } = await runAgainst(item);
			try {
				await client.create({ idempotencyKey: "hobo-prisma-contract-02" });
				expect.unreachable("a contracted failure must throw");
			} catch (error) {
				// SAFETY: value was established by the surrounding parse or typed constructor.
				expect((error as PrismaProviderError).code).toBe(
					item.response.mapsToHoboCode,
				);
			}
		});
	}

	it("emits the contracted argv for a shortened lifetime", async () => {
		const item = interaction(
			"ask for a shorter lifetime than the 24-hour default",
		);
		const { runner, client } = await runAgainst(item);
		await client.create({
			idempotencyKey: "hobo-prisma-contract-04",
			region: "eu-central-1",
			ttl: "4h",
		});
		expect(runner.runs[0]?.argv).toEqual(item.request.argv);
	});

	it("covers every interaction the contract declares", () => {
		// A contract nobody executes is documentation. Anyone adding an
		// interaction has to add a test with it, and this is what says so.
		const exercised = new Set([
			"create a temporary database and ask for the machine-readable document",
			"create in a documented region, as one fused argv element",
			"ask for a shorter lifetime than the 24-hour default",
			"rate limited by the create-db worker",
			"upstream 5xx: the CLI reached the service, so a create may or may not have happened",
			"the CLI dies without printing a document",
			"a CLI build without --json prints the documented pretty output",
		]);
		const unexercised = contract.interactions
			.map((item) => item.description)
			.filter((description) => !exercised.has(description));
		expect(unexercised).toEqual([]);
	});

	it("omits --json for the pretty-output interaction and reads it with human-v1", async () => {
		const item = interaction(
			"a CLI build without --json prints the documented pretty output",
		);
		const { runner, client } = await runAgainst(item, "human-v1");
		const outcome = await client.create({
			idempotencyKey: "hobo-prisma-contract-03",
		});

		expect(runner.runs[0]?.argv).toEqual(item.request.argv);
		expect(outcome.kind === "created" && outcome.result.outputMode).toBe(
			"human-v1",
		);
	});

	it("parses each contracted success document the contract points at", () => {
		expect(parseCreateDbJson(fixture("create.success.json")).projectId).toMatch(
			/^proj_/u,
		);
		expect(
			parseCreateDbHumanV1(fixture("create.human.txt"), { region: "us-east-1" })
				.projectId,
		).toMatch(/^proj_/u);
	});
});
