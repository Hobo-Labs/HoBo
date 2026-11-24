import { describe, expect, it } from "vitest";

import {
	ensureInfisicalAgentVaultCli,
	INFISICAL_CLI_VERSION,
	type RunCommand,
} from "../src/index.js";

const TOOLS = "/hobo-tools";
const INSTALLED = "/hobo-tools/node_modules/.bin/infisical";

function machine(versions: Record<string, string>) {
	const calls: string[] = [];
	const run: RunCommand = async (command, args) => {
		calls.push([command, ...args].join(" "));
		if (args[0] === "--version") {
			const version = versions[command];
			return version === undefined
				? { code: 127, stdout: "", stderr: "not found" }
				: { code: 0, stdout: `infisical version ${version}\n`, stderr: "" };
		}
		versions[INSTALLED] = INFISICAL_CLI_VERSION;
		return { code: 0, stdout: "", stderr: "" };
	};
	return { calls, run };
}

describe("ensureInfisicalAgentVaultCli", () => {
	it("uses the CLI on PATH when it already runs the Agent Vault proxy", async () => {
		const { calls, run } = machine({ infisical: "0.46.0" });
		expect(
			await ensureInfisicalAgentVaultCli({
				run,
				which: async () => "/usr/bin/infisical",
				toolsDir: TOOLS,
			}),
		).toBe("infisical");
		expect(calls).toEqual(["infisical --version"]);
	});

	it("installs the pinned release when the CLI found is older", async () => {
		const { calls, run } = machine({
			infisical: "0.45.8",
			[INSTALLED]: "0.45.8",
		});
		expect(
			await ensureInfisicalAgentVaultCli({
				run,
				which: async () => "/usr/bin/infisical",
				toolsDir: TOOLS,
				exists: (file) => file === INSTALLED,
			}),
		).toBe(INSTALLED);
		expect(calls).toEqual([
			"infisical --version",
			`${INSTALLED} --version`,
			`npm install --prefix ${TOOLS} --no-fund --no-audit @infisical/cli@${INFISICAL_CLI_VERSION}`,
		]);
	});

	it("reuses HoBo's own install when it is recent enough", async () => {
		const { calls, run } = machine({
			infisical: "0.40.0",
			[INSTALLED]: INFISICAL_CLI_VERSION,
		});
		expect(
			await ensureInfisicalAgentVaultCli({
				run,
				which: async () => "/usr/bin/infisical",
				toolsDir: TOOLS,
				exists: (file) => file === INSTALLED,
			}),
		).toBe(INSTALLED);
		expect(calls).toHaveLength(2);
	});
});
