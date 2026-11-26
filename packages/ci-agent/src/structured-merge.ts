import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPolicies, type ParsedAgentConfig } from "./config.js";

/** The three sides of one conflicted file. */
export type StructuredMergeInput = Readonly<{
	path: string;
	base: string;
	ours: string;
	theirs: string;
	signal: AbortSignal;
}>;

/**
 * A syntax-aware three-way merge. It returns the merged file only when it
 * merged with no conflict left; anything else (a conflict it could not
 * settle, an unsupported language, a failure) is `undefined`, and the merge
 * goes on as git left it.
 */
export interface StructuredMerger {
	readonly id: string;
	merge(input: StructuredMergeInput): Promise<string | undefined>;
}

type Run = (
	command: string,
	args: readonly string[],
	options: Readonly<{
		cwd: string;
		env: NodeJS.ProcessEnv;
		signal: AbortSignal;
	}>,
) => Promise<{ code: number }>;

const runProcess: Run = (command, args, options) =>
	new Promise((resolve, reject) => {
		const child = execFile(
			command,
			[...args],
			{ ...options, maxBuffer: 1024 * 1024, windowsHide: true },
			(error) => {
				if (!error) resolve({ code: 0 });
				else if (child.exitCode !== null) resolve({ code: child.exitCode });
				else reject(error);
			},
		);
	});

/** Conflict markers mergiraf writes, at any length from git's default. */
const MARKER = /^(?:<{7,}|>{7,}|\|{7,}|={7,})(?: |\r?$)/m;

/**
 * [mergiraf](https://mergiraf.org) as the structured merge, run as
 * `mergiraf merge BASE LEFT RIGHT -p PATH -o OUT -t MS`: exit 0 is a clean
 * merge, 1 a merge with conflicts left, anything else a failure (mergiraf
 * v0.20). The path names the file's language by its extension. It runs in an
 * empty directory, with an environment of `PATH` alone and its cache there,
 * so it reads no repository settings and keeps nothing between merges.
 */
export function createMergirafMerger(
	options: Readonly<{
		command?: string;
		/** How long one file may take before git's merge stands (ms). */
		timeoutMs?: number;
		run?: Run;
	}> = {},
): StructuredMerger {
	const command = options.command ?? "mergiraf";
	const run = options.run ?? runProcess;
	const timeoutMs = options.timeoutMs ?? 10_000;
	return {
		id: "mergiraf",
		async merge(input) {
			const directory = await mkdtemp(join(tmpdir(), "hobo-ci-agent-mgf-"));
			try {
				const file = (name: string) => join(directory, name);
				const output = file("output");
				await Promise.all([
					writeFile(file("base"), input.base),
					writeFile(file("left"), input.ours),
					writeFile(file("right"), input.theirs),
				]);
				const { code } = await run(
					command,
					[
						"merge",
						file("base"),
						file("left"),
						file("right"),
						"--path-name",
						input.path,
						"--output",
						output,
						"--timeout",
						String(timeoutMs),
					],
					{
						cwd: directory,
						env: {
							PATH: process.env.PATH ?? "",
							HOME: directory,
							XDG_CACHE_HOME: directory,
						},
						signal: input.signal,
					},
				);
				if (code !== 0) return undefined;
				const merged = await readFile(output, "utf8");
				// A clean exit with markers in the text is not trusted.
				return MARKER.test(merged) ? undefined : merged;
			} catch {
				return undefined;
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	};
}

/** Whether the command answers at all: run once at start-up, so a missing install fails early. */
export async function checkMergiraf(
	options: Readonly<{ command?: string; run?: Run }> = {},
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-agent-mgf-"));
	try {
		const { code } = await (options.run ?? runProcess)(
			options.command ?? "mergiraf",
			["--version"],
			{
				cwd: directory,
				env: { PATH: process.env.PATH ?? "" },
				signal: AbortSignal.timeout(10_000),
			},
		).catch(() => ({ code: -1 }));
		if (code !== 0)
			throw new Error(
				"resolution.structuredMerge is on, but `mergiraf` is not installed",
			);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * The structured merge a configuration asks for: none, or mergiraf, checked
 * to be installed. A file gets as long as an engine call would.
 */
export async function configuredStructuredMerger(
	config: ParsedAgentConfig,
	options: Readonly<{ command?: string; run?: Run }> = {},
): Promise<StructuredMerger | undefined> {
	const { resolution, budget } = agentPolicies(config);
	if (!resolution.structuredMerge) return undefined;
	await checkMergiraf(options);
	return createMergirafMerger({
		...options,
		timeoutMs: budget.timeoutSeconds * 1000,
	});
}
