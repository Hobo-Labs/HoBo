#!/usr/bin/env node
import { type FixturePhase, runExampleFixture } from "../src/fixture-runner.js";

interface ExampleFixtureCliArgs {
	fixture?: string;
	phase?: string;
	"run-id"?: string;
}

function parseArgs(argv: readonly string[]): ExampleFixtureCliArgs {
	const parsed: ExampleFixtureCliArgs = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg?.startsWith("--")) {
			continue;
		}
		const key = arg.slice(2);
		const next = argv[index + 1];
		const value = next && !next.startsWith("--") ? next : "true";
		if (next && !next.startsWith("--")) {
			index += 1;
		}
		if (key === "fixture") {
			parsed.fixture = value;
		} else if (key === "phase") {
			parsed.phase = value;
		} else if (key === "run-id") {
			parsed["run-id"] = value;
		}
	}
	return parsed;
}

function parseFixturePhase(value: string): FixturePhase | undefined {
	if (
		value === "deploy-and-assert" ||
		value === "teardown" ||
		value === "sweep-orphans"
	) {
		return value;
	}
	return undefined;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const fixture = args.fixture;
	const phaseArg = args.phase;
	const runId = args["run-id"] ?? process.env.GITHUB_RUN_ID ?? "local-run";

	if (!fixture || !phaseArg) {
		console.error(
			"usage: run-example-fixture.ts --fixture <path> --phase <phase> --run-id <id>",
		);
		process.exitCode = 1;
		return;
	}

	const phase = parseFixturePhase(phaseArg);
	if (phase === undefined) {
		throw new Error(`unknown phase: ${phaseArg}`);
	}

	if (process.env.GITHUB_ACTIONS === "true") {
		assertGitHubOidcEnvironment();
	}

	await runExampleFixture({ fixture, phase, runId });
}

function assertGitHubOidcEnvironment(): void {
	const missing = [
		"ACTIONS_ID_TOKEN_REQUEST_URL",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
	].filter((name) => !process.env[name]);
	if (missing.length > 0) {
		throw new Error(
			`GitHub OIDC token environment missing: ${missing.join(", ")}`,
		);
	}

	const storedSecretKeys = Object.keys(process.env)
		.filter((key) => /SECRET|ACCESS_KEY|PRIVATE_KEY/i.test(key))
		.filter((key) => key !== "ACTIONS_ID_TOKEN_REQUEST_TOKEN")
		.sort();
	if (storedSecretKeys.length > 0) {
		throw new Error(
			`stored cloud secret environment is not allowed: ${storedSecretKeys.join(", ")}`,
		);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
