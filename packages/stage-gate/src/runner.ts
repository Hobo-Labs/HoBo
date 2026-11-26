import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import {
	CHECK_OUTPUT_LIMIT,
	checkStatusOf,
	NOT_RUN_EXIT_CODE,
	NOT_STARTED_EXIT_CODE,
	REQUIRED_EVIDENCE_ENV,
	recordStatusOf,
	requiredEvidenceOf,
	runnerExitCodeOf,
	unmetRequirements,
} from "./gate-status.js";
import { isJsonString, parseJsonText } from "./json.js";
import { serializeStageGateRecord } from "./parse.js";
import type {
	CheckEvidence,
	CheckResult,
	ComponentArtifact,
	RunStageGateOptions,
	RunStageGateResult,
	SignatureEvidence,
	StageGateDefinition,
	StageGateRecord,
} from "./types.js";

function readRepoCommit(cwd: string): string {
	try {
		return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

export function resolveCommandExecutable(
	executable: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "win32" && executable === "pnpm") {
		return resolveWindowsPnpmExecutable(env);
	}
	return executable;
}

function resolveWindowsPnpmExecutable(env: NodeJS.ProcessEnv): string {
	const pathValue = env.Path ?? env.PATH ?? "";
	const pathEntries = pathValue.split(delimiter).filter(Boolean);
	const searchRoots = [env.PNPM_HOME, ...pathEntries].filter(
		(root): root is string => Boolean(root),
	);
	const candidates = searchRoots
		.map((root) => join(root, "pnpm.cmd"))
		.filter((candidate) => existsSync(candidate));
	return (
		candidates.find((candidate) => !isNodeModulesBinShim(candidate)) ??
		"corepack"
	);
}

function isNodeModulesBinShim(path: string): boolean {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	return normalized.includes("/node_modules/.bin/");
}

export function shouldUseCommandShell(
	executable: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "win32" && /\.(?:bat|cmd)$/i.test(executable);
}

function quoteWindowsShellArg(value: string): string {
	return `"${value.replaceAll('"', '\\"')}"`;
}

/** The process to spawn for a check command, after platform resolution. */
export interface CommandInvocation {
	readonly executable: string;
	readonly args: string[];
	readonly windowsVerbatimArguments?: boolean;
}

export function createCommandInvocation(
	executable: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	comspec = process.env.ComSpec ?? "cmd.exe",
	env: NodeJS.ProcessEnv = process.env,
): CommandInvocation {
	const resolvedExecutable = resolveCommandExecutable(
		executable,
		platform,
		env,
	);
	if (
		platform === "win32" &&
		executable === "pnpm" &&
		resolvedExecutable === "corepack"
	) {
		return { executable: resolvedExecutable, args: ["pnpm", ...args] };
	}
	if (!shouldUseCommandShell(resolvedExecutable, platform)) {
		return { executable: resolvedExecutable, args: [...args] };
	}
	const commandText = [
		quoteWindowsShellArg(resolvedExecutable),
		...args.map(quoteWindowsShellArg),
	].join(" ");
	return {
		executable: comspec,
		args: ["/d", "/s", "/c", `"${commandText}"`],
		windowsVerbatimArguments: true,
	};
}

/** A check's exit code and the output it left, before evidence parsing. */
interface CheckRun {
	readonly exitCode: number;
	readonly evidence: Record<string, string>;
	/** It outlived its `timeoutMs` and was stopped. */
	readonly timedOut: boolean;
}

function runCheck(
	command: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs?: number,
): CheckRun {
	const [executable, ...args] = command;
	if (!executable) {
		return {
			exitCode: 1,
			evidence: { error: "empty command" },
			timedOut: false,
		};
	}
	const invocation = createCommandInvocation(
		executable,
		args,
		process.platform,
		process.env.ComSpec ?? "cmd.exe",
		env,
	);
	const result = spawnSync(invocation.executable, invocation.args, {
		cwd,
		env,
		encoding: "utf8",
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: CHECK_OUTPUT_LIMIT,
		killSignal: "SIGTERM",
		// undefined: no bound, as before timeoutMs existed.
		timeout: timeoutMs,
	});
	const timedOut =
		result.error !== undefined &&
		"code" in result.error &&
		result.error.code === "ETIMEDOUT";
	const exitCode = timedOut ? NOT_RUN_EXIT_CODE : (result.status ?? 1);
	const failed = exitCode !== 0;
	const evidence: Record<string, string> = {};
	if (timedOut) {
		evidence.error = `${command.join(" ")} did not finish within ${timeoutMs} ms (timeoutMs): stopped with SIGTERM`;
	} else if (result.error) {
		evidence.error = `${result.error.name}: ${result.error.message}`;
	}
	if (result.stdout?.trim()) {
		evidence.stdout = trimEvidence(result.stdout, exitCode);
	}
	if (result.stderr?.trim()) {
		evidence.stderr = trimEvidence(result.stderr, exitCode);
	}
	if (failed) {
		console.error(
			`[stage-gate] check failed: ${command.join(" ")} (exit ${exitCode})`,
		);
		if (evidence.stderr) {
			console.error(evidence.stderr);
		}
		if (evidence.stdout) {
			console.error(evidence.stdout);
		}
	}
	return {
		exitCode,
		evidence,
		timedOut,
	};
}

function trimEvidence(output: string, exitCode: number): string {
	const text = output.trim();
	if (exitCode === 0) {
		return text.slice(0, 4000);
	}
	if (text.length <= 12_000) {
		return text;
	}
	return `${text.slice(0, 4000)}\n\n... output truncated; failure tail follows ...\n\n${text.slice(-8000)}`;
}

function parseEvidenceJson(stdout: string | undefined): CheckEvidence {
	const evidence: Record<string, string> = {};
	if (!stdout) {
		return evidence;
	}
	const lines = stdout.trim().split("\n");
	const parsed = parseJsonText(lines.at(-1) ?? "");
	if (parsed === undefined || parsed === null) {
		// Return the text as-is. `stdout` has already been through
		// `trimEvidence`, which is the only place that should decide how much of
		// a check's output to keep, because it is the only place that knows the
		// exit code. Re-truncating here to a flat 4000 characters discarded the
		// failure tail that `trimEvidence` had just gone to the trouble of
		// preserving — so for a failing check that printed a long non-JSON log
		// (a failing test suite, the common case) the record kept only the first
		// 4000 characters and threw away the end, which is where the reason is.
		evidence.stdout = stdout;
		return evidence;
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (isJsonString(value)) {
			evidence[key] = value;
		} else if (value !== undefined && value !== null) {
			evidence[key] = JSON.stringify(value);
		}
	}
	return evidence;
}

function mergeArtifactEvidence(
	evidence: Record<string, string>,
): ComponentArtifact | undefined {
	const digest = evidence.component_digest ?? evidence.digest_sha256;
	const mediaType = evidence.media_type;
	const byteLengthRaw = evidence.byte_length;
	if (!digest || !mediaType || !byteLengthRaw) {
		return undefined;
	}
	// `Number.parseInt` stops at the first character it cannot use, so it
	// silently *reinterprets* a malformed length rather than rejecting it:
	// "1.5" becomes 1, "1e3" becomes 1, "10abc" becomes 10. Each of those is a
	// whole non-negative integer, so the checks below pass and the record ends
	// up claiming a byte length the check never measured — which a verifier
	// comparing the recorded length against the real artifact reads as a
	// mismatch on a perfectly good build. Require the string to be digits.
	if (!/^\d+$/u.test(byteLengthRaw)) {
		return undefined;
	}
	const byteLength = Number.parseInt(byteLengthRaw, 10);
	if (!Number.isInteger(byteLength) || byteLength < 0) {
		return undefined;
	}
	return {
		digestSha256: digest,
		byteLength,
		mediaType,
	};
}

function mergeSignatureEvidence(
	evidence: Record<string, string>,
): SignatureEvidence | undefined {
	if (evidence.signature_verified !== "true") {
		return undefined;
	}
	return {
		verified: true,
		signerIdentity: evidence.signer_identity ?? "",
		provenanceTier: evidence.provenance_tier ?? "",
		conformanceReportDigest: evidence.conformance_report_digest ?? "",
	};
}

export async function runStageGate(
	definition: StageGateDefinition,
	opts: RunStageGateOptions = {},
): Promise<RunStageGateResult> {
	const cwd = opts.cwd ?? process.cwd();
	const startedAt = new Date().toISOString();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...opts.env,
	};
	const checkResults: CheckResult[] = [];
	let artifact: ComponentArtifact = {
		digestSha256: `sha256:${"0".repeat(64)}`,
		byteLength: 0,
		mediaType: "application/octet-stream",
	};
	let signature: SignatureEvidence = {
		verified: false,
		signerIdentity: "",
		provenanceTier: "",
		conformanceReportDigest: "",
	};
	const passed = new Map<string, CheckEvidence>();

	const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
	const reproducibleKinds = new Set(["build", "sign", "verify"]);

	for (const check of definition.checks) {
		const unmet = unmetRequirements(check, passed);
		if (unmet.length > 0) {
			checkResults.push({
				checkId: check.checkId,
				command: check.command,
				exitCode: NOT_STARTED_EXIT_CODE,
				status: "skipped",
				evidence: { skipped_because: `${unmet.join(", ")} did not pass` },
			});
			continue;
		}
		const checkEnv =
			sourceDateEpoch && reproducibleKinds.has(check.kind)
				? { ...env, SOURCE_DATE_EPOCH: sourceDateEpoch }
				: (() => {
						const { SOURCE_DATE_EPOCH: _omit, ...rest } = env;
						return rest;
					})();
		const { [REQUIRED_EVIDENCE_ENV]: _inherited, ...ownEnv } = checkEnv;
		const handed = requiredEvidenceOf(check, passed);
		const {
			exitCode,
			evidence: rawEvidence,
			timedOut,
		} = runCheck(
			check.command,
			cwd,
			handed === undefined
				? ownEnv
				: { ...ownEnv, [REQUIRED_EVIDENCE_ENV]: handed },
			check.timeoutMs instanceof Function
				? check.timeoutMs(ownEnv)
				: check.timeoutMs,
		);
		const evidence = parseEvidenceJson(rawEvidence.stdout ?? undefined);
		if (Object.keys(evidence).length === 0) {
			Object.assign(evidence, rawEvidence);
		}
		const status = timedOut ? "not_run" : checkStatusOf(check, exitCode);
		if (status === "passed") {
			passed.set(check.checkId, evidence);
		}
		checkResults.push({
			checkId: check.checkId,
			command: check.command,
			exitCode,
			status,
			evidence,
		});
		const artifactEvidence = mergeArtifactEvidence(evidence);
		if (artifactEvidence) {
			artifact = artifactEvidence;
		}
		const signatureEvidence = mergeSignatureEvidence(evidence);
		if (signatureEvidence) {
			signature = signatureEvidence;
		}
	}

	const finishedAt = new Date().toISOString();
	const status = recordStatusOf(checkResults);
	const record: StageGateRecord = {
		gateId: definition.gateId,
		status,
		repoCommit: readRepoCommit(cwd),
		ciRunUrl: opts.ciRunUrl ?? process.env.GITHUB_RUN_URL ?? "",
		startedAt,
		finishedAt,
		checks: checkResults,
		artifact,
		signature,
	};

	if (opts.outFile) {
		await mkdir(dirname(opts.outFile), { recursive: true });
		await writeFile(
			opts.outFile,
			`${JSON.stringify(serializeStageGateRecord(record), null, 2)}\n`,
			"utf8",
		);
	}

	return {
		record,
		exitCode: runnerExitCodeOf(status),
	};
}
