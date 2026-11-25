import { checkCodegen, preflightBuf, runCodegen } from "./codegen.js";
import { parseCodegenArgv } from "./parse.js";
import {
	type CodegenInvocation,
	exitCodeForReport,
	reportToJson,
} from "./types.js";

export async function runCli(
	argv: readonly string[],
	cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	let invocation: CodegenInvocation | undefined;
	try {
		invocation = parseCodegenArgv(argv, cwd);
		await preflightBuf(invocation);
		const report = invocation.check
			? await checkCodegen(invocation)
			: await runCodegen(invocation);
		const stdout = invocation.json ? reportToJson(report) : formatHuman(report);
		return { exitCode: exitCodeForReport(report), stdout, stderr: "" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (invocation?.json) {
			return {
				exitCode: 1,
				stdout: `${JSON.stringify({
					status: "ERROR",
					drift: [],
					cueViolations: [
						{ package: "schema-tools", constraint: "preflight", message },
					],
					durationMs: 0,
				})}\n`,
				stderr: "",
			};
		}
		return { exitCode: 1, stdout: "", stderr: `${message}\n` };
	}
}

function formatHuman(report: {
	status: string;
	drift: readonly { path: string; kind: string }[];
	cueViolations: readonly {
		package: string;
		constraint: string;
		message: string;
	}[];
	durationMs: number;
}): string {
	const lines = [
		`status: ${report.status}`,
		`durationMs: ${report.durationMs}`,
	];
	for (const entry of report.drift) {
		lines.push(`drift: ${entry.kind} ${entry.path}`);
	}
	for (const violation of report.cueViolations) {
		lines.push(
			`cue: ${violation.package}/${violation.constraint}: ${violation.message}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
	const result = await runCli(process.argv.slice(2));
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("cli.ts") || entryPath.endsWith("cli.js")) {
	void main();
}
