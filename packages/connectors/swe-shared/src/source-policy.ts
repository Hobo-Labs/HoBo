import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const guard = fileURLToPath(
	new URL("../../../../scripts/agent-source-policy.mts", import.meta.url),
);

export function withSourcePolicy(instruction: string): string {
	return [
		"Follow AGENTS.md and the repository source policy. Write self-documenting code without explanatory comments or deferred-work markers. Complete unfinished work and remove planning and design documents.",
		instruction,
	].join("\n\n");
}

export async function sourcePolicyBase(workspace: string): Promise<string> {
	const result = await run("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: workspace,
		timeout: 10_000,
	});
	return result.stdout.trim();
}

export async function assertSourcePolicy(
	workspace: string,
	base: string,
): Promise<void> {
	await run(
		process.execPath,
		["--experimental-strip-types", guard, `--base=${base}`],
		{ cwd: workspace, timeout: 100_000, maxBuffer: 4 * 1024 * 1024 },
	);
}
