/**
 * The `hobo fleet` entry of the composed binary. `hobo fleet` parses its own
 * words strictly, so the binary hands them over before the shell's global
 * option parser (which knows no fleet option) sees them. `--json` as the first
 * word prints the result as JSON.
 */
import type { FleetCommandDeps, FleetResult } from "./fleet-command.js";
import { runFleetCommand } from "./fleet-command.js";
import { createFleetRuntime } from "./fleet-runtime.js";

export type FleetCliOutput = Readonly<{
	stdout(text: string): void;
	stderr(text: string): void;
}>;

const PROCESS_OUTPUT: FleetCliOutput = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

/** The exit code of a result: 0 ok, 2 a usage error, 1 anything else. */
export function exitCodeOf(result: FleetResult): number {
	if (result.ok !== false) return 0;
	return result.status === "usage" ? 2 : 1;
}

export async function runFleetCli(
	argv: readonly string[],
	options: Readonly<{
		output?: FleetCliOutput;
		deps?: (progress: (message: string) => void) => FleetCommandDeps;
	}> = {},
): Promise<number> {
	const output = options.output ?? PROCESS_OUTPUT;
	const json = argv[0] === "--json";
	const words = json ? argv.slice(1) : argv;
	const progress = (message: string) => output.stderr(`${message}\n`);
	const deps =
		options.deps?.(progress) ??
		createFleetRuntime({ env: process.env, progress });
	const result = await runFleetCommand(words, deps);
	const code = exitCodeOf(result);
	if (json)
		output.stdout(
			`${JSON.stringify({
				ok: code === 0,
				verb: "fleet",
				code: result.code ?? (code === 0 ? "HOBO_OK" : "HOBO_CLI_ERROR"),
				message: result.message ?? "",
				data: result.data ?? {},
			})}\n`,
		);
	else if (result.message !== undefined && result.message.length > 0)
		(code === 0 ? output.stdout : output.stderr)(`${result.message}\n`);
	return code;
}
