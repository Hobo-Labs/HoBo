import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPolicies, type ParsedAgentConfig } from "./config.js";

export type StructuredMergeInput = Readonly<{
	path: string;
	base: string;
	ours: string;
	theirs: string;
	signal: AbortSignal;
}>;

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

const MARKER = /^(?:<{7,}|>{7,}|\|{7,}|={7,})(?: |\r?$)/m;

export function createMergirafMerger(
	options: Readonly<{
		command?: string;
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
				return MARKER.test(merged) ? undefined : merged;
			} catch {
				return undefined;
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	};
}

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
