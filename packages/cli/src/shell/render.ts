import { isJsonString } from "../json.js";
import type {
	CliContext,
	CliEnvelope,
	CommandResult,
} from "../types/envelope.js";
import { buildEnvelope, publicContext } from "../types/envelope.js";
import { CliError } from "./errors.js";
import type { CliFlags } from "./parse.js";

export interface CliRunResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function renderSuccess(input: {
	readonly verb: string;
	readonly flags: CliFlags;
	readonly context: CliContext;
	readonly result: CommandResult;
}): CliRunResult {
	const envelope = buildEnvelope(input);
	const exitCode = envelope.ok
		? 0
		: envelope.code === "HOBO_BUILD_USAGE" || envelope.code === "HOBO_CLI_USAGE"
			? 2
			: 1;

	if (input.flags.json) {
		return okText(`${JSON.stringify(envelope)}\n`, exitCode);
	}

	if (input.flags.quiet) {
		// Quiet suppresses success chrome, never failure signal: errors still
		// print (stderr) so `-q` scripts see why the command failed.
		if (!envelope.ok) {
			return { exitCode, stdout: "", stderr: `${envelope.message}\n` };
		}
		return okText("", exitCode);
	}

	if (input.verb === "new" && envelope.ok) {
		const nextSteps = Array.isArray(envelope.data.nextSteps)
			? envelope.data.nextSteps.filter(isJsonString).join("\n")
			: "";
		return okText(
			`Created HoBo project ${String(envelope.data.name ?? "")}\n\n${nextSteps}\n`,
			exitCode,
		);
	}

	// A result that did not succeed names its code and every way forward: the
	// person reading it has nothing else to go on.
	const next =
		!envelope.ok && envelope.remediation.length > 0
			? `\n${envelope.code}\n${envelope.remediation.map((line) => `- ${line}`).join("\n")}\n`
			: "";
	return okText(
		`Command  Status
${input.verb.padEnd(8)} ${envelope.status}

${envelope.message}
${next}`,
		exitCode,
	);
}

export function renderError(
	// A caught binding, which is `unknown`.
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: a caught binding has no type; it is only narrowed with instanceof and summarized.
	error: unknown,
	input: {
		readonly verb: string | null;
		readonly flags: CliFlags;
		readonly context?: CliContext;
	},
): CliRunResult {
	if (error instanceof CliError) {
		if (input.flags.json) {
			const envelope: CliEnvelope = {
				ok: false,
				verb: input.verb ?? "",
				status: "error",
				code: error.code,
				message: error.message.split("\n")[0] ?? error.message,
				remediation: error.remediation,
				context: publicContext(
					input.context ?? {
						cwd: input.flags.cwd,
						projectDir: null,
						identity: null,
						clients: { readApi: "stub", runtime: "stub" },
					},
				),
				data: {},
			};
			return {
				exitCode: error.exitCode,
				stdout: `${JSON.stringify(envelope)}\n`,
				stderr: "",
			};
		}

		return {
			exitCode: error.exitCode,
			stdout: "",
			stderr: `${error.message}\n`,
		};
	}

	const diagnostics = verboseDiagnostics(error, input.flags.verbose);

	if (input.flags.json) {
		const envelope: CliEnvelope = {
			ok: false,
			verb: input.verb ?? "",
			status: "error",
			code: "HOBO_CLI_INTERNAL",
			message: input.flags.verbose
				? `Internal CLI error: ${errorMessage(error)}`
				: "Internal CLI error. Re-run with --verbose for diagnostics.",
			remediation: input.flags.verbose
				? ["Report the stderr diagnostics."]
				: ["Re-run with --verbose and report the stderr output."],
			context: publicContext(
				input.context ?? {
					cwd: input.flags.cwd,
					projectDir: null,
					identity: null,
					clients: { readApi: "stub", runtime: "stub" },
				},
			),
			data: {},
		};
		return {
			exitCode: 1,
			stdout: `${JSON.stringify(envelope)}\n`,
			stderr: diagnostics,
		};
	}

	return {
		exitCode: 1,
		stdout: "",
		stderr:
			diagnostics !== ""
				? diagnostics
				: "Internal CLI error. Re-run with --verbose for diagnostics.\n",
	};
}

// Both of these are handed a caught binding and already narrow it themselves
// with `instanceof Error ? … : String(error)`.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: a caught binding, narrowed with instanceof before use.
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: a caught binding, narrowed with instanceof before use.
function verboseDiagnostics(error: unknown, verbose: boolean): string {
	if (!verbose) {
		return "";
	}
	const stack =
		error instanceof Error && isJsonString(error.stack)
			? error.stack
			: errorMessage(error);
	return `Internal CLI error.\n${stack}\n`;
}

function okText(stdout: string, exitCode = 0): CliRunResult {
	return {
		exitCode,
		stdout,
		stderr: "",
	};
}

export function envelopeToRunResult(
	envelope: CliEnvelope,
	flags: CliFlags,
): CliRunResult {
	if (flags.json) {
		return okText(`${JSON.stringify(envelope)}\n`, envelope.ok ? 0 : 1);
	}
	return renderSuccess({
		verb: envelope.verb,
		flags,
		context: envelope.context,
		result: envelope,
	});
}
