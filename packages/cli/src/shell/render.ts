import { CollectionEngineError } from "@hobo/bindles";
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

	return okText(
		`Command  Status
${input.verb.padEnd(8)} ${envelope.status}

${envelope.message}
`,
		exitCode,
	);
}

export function renderError(
	cause: unknown,
	input: {
		readonly verb: string | null;
		readonly flags: CliFlags;
		readonly context?: CliContext;
	},
): CliRunResult {
	if (
		cause instanceof CollectionEngineError &&
		cause.code === "HOBO_BINDING_DELIVERY"
	) {
		return renderError(
			new CliError(cause.message, 1, cause.code, [
				"Use linked bindings for credentials.",
			]),
			input,
		);
	}
	if (cause instanceof CliError) {
		if (input.flags.json) {
			const envelope: CliEnvelope = {
				ok: false,
				verb: input.verb ?? "",
				status: "error",
				code: cause.code,
				message: cause.message.split("\n")[0] ?? cause.message,
				remediation: cause.remediation,
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
				exitCode: cause.exitCode,
				stdout: `${JSON.stringify(envelope)}\n`,
				stderr: "",
			};
		}

		return {
			exitCode: cause.exitCode,
			stdout: "",
			stderr: `${cause.message}\n`,
		};
	}

	const diagnostics = verboseDiagnostics(cause, input.flags.verbose);

	if (input.flags.json) {
		const envelope: CliEnvelope = {
			ok: false,
			verb: input.verb ?? "",
			status: "error",
			code: "HOBO_CLI_INTERNAL",
			message: input.flags.verbose
				? `Internal CLI error: ${errorMessage(cause)}`
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

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function verboseDiagnostics(cause: unknown, verbose: boolean): string {
	if (!verbose) {
		return "";
	}
	const stack =
		cause instanceof Error && isJsonString(cause.stack)
			? cause.stack
			: errorMessage(cause);
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
