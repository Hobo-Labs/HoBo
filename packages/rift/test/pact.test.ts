/**
 * Provider verification for the CLI boundary.
 *
 * `@hobo/code` drives `hobo-rift` by argv and reads exit code plus stdout — it
 * has no other way in. A pact file that nobody executes is decoration, so this
 * runs the built CLI once per interaction in a throwaway root and checks the
 * response the contract promises.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const cli = join(pkg, "dist", "bin", "hobo-rift.js");

interface Interaction {
	readonly description: string;
	readonly request: { readonly argv: string[] };
	readonly response: {
		readonly exitCode: number;
		readonly jsonKeys?: string[];
		readonly stdoutContains?: string;
		readonly stdoutLastLineIsAbsolutePath?: boolean;
		readonly stderrMatches?: string;
		readonly repeatable?: boolean;
	};
}

// SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
const pact = JSON.parse(
	readFileSync(
		join(pkg, "contracts", "pacts", "rift-workspace-boundary.pact.json"),
		"utf8",
	),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
};

let root: string;

function run(argv: readonly string[]) {
	const result = spawnSync(process.execPath, [cli, "--root", root, ...argv], {
		encoding: "utf8",
	});
	return {
		code: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

beforeAll(() => {
	// The contract is against the shipped artifact, not the sources.
	if (!existsSync(cli)) {
		throw new Error(
			`build packages/rift before verifying the pact: ${cli} missing`,
		);
	}
	root = mkdtempSync(join(tmpdir(), "rift-pact-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "app.ts"), "original\n");
});

describe(`${pact.consumer.name} → ${pact.provider.name}`, () => {
	// Sequential: later interactions depend on earlier state (create → duplicate
	// → exec → remove), which is exactly the order the consumer uses them in.
	for (const interaction of pact.interactions) {
		it(interaction.description, () => {
			const got = run(interaction.request.argv);
			expect(
				got.code,
				`${interaction.request.argv.join(" ")}\nstdout: ${got.stdout}\nstderr: ${got.stderr}`,
			).toBe(interaction.response.exitCode);

			if (interaction.response.jsonKeys) {
				// SAFETY: `const parsed = JSON.parse(got.stdout) as JsonObject;` is required at this I/O or test boundary.
				const parsed = JSON.parse(got.stdout) as JsonObject;
				for (const key of interaction.response.jsonKeys) {
					expect(parsed).toHaveProperty(key);
				}
			}
			if (interaction.response.stdoutContains) {
				expect(got.stdout).toContain(interaction.response.stdoutContains);
			}
			if (interaction.response.stdoutLastLineIsAbsolutePath) {
				const lines = got.stdout.trim().split("\n");
				expect(lines[lines.length - 1]?.startsWith("/")).toBe(true);
			}
			if (interaction.response.stderrMatches) {
				expect(`${got.stdout}${got.stderr}`).toMatch(
					new RegExp(interaction.response.stderrMatches),
				);
			}
			if (interaction.response.repeatable) {
				// Idempotence is load-bearing: the consumer calls init before every create.
				expect(run(interaction.request.argv).code).toBe(
					interaction.response.exitCode,
				);
			}
		});
	}

	it("leaves nothing behind after the removal interaction", () => {
		expect(existsSync(join(root, ".hobo-rift", "workspaces", "claude"))).toBe(
			false,
		);
		rmSync(root, { recursive: true, force: true });
	});
});
