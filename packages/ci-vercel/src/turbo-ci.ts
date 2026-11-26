import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { z } from "zod";
import {
	type TurboCiPlan,
	TurboCiPlanSchema,
} from "./_generated/turbo_ci_pb.js";

// Task tags are resolved by Turbo, including package overrides and $TURBO_EXTENDS$.
const query =
	"query { packages { items { name tags tasks { items { fullName tags } } } } }";
const taskId = z
	.string()
	.max(512)
	.regex(/^[^-\s#][^\s#]*#[^\s#]+$/);
const graph = z.object({
	data: z.object({
		packages: z.object({
			items: z.array(
				z.object({
					name: z.string(),
					tags: z.array(z.string()),
					tasks: z.object({
						items: z.array(
							z.object({ fullName: taskId, tags: z.array(z.string()) }),
						),
					}),
				}),
			),
		}),
	}),
});
const dryRun = z.object({
	tasks: z.array(
		z.object({
			taskId,
			command: z.string(),
			resolvedTaskDefinition: z.object({
				persistent: z.boolean(),
			}),
		}),
	),
});
const affectedGraph = z.object({
	data: z.object({
		affectedTasks: z.object({ items: z.array(z.object({ fullName: taskId })) }),
	}),
});

/** Local wiring only. This runs trusted checkout code with the caller's permissions. */
export interface TurboCiOptions {
	cwd: string;
	/** Path to the installed turbo Node launcher; defaults to the checkout's dependency. */
	turboPath?: string;
	affected?: boolean;
	base?: string;
	head?: string;
	remoteCache?: boolean;
	signal?: AbortSignal;
}

function command(
	options: TurboCiOptions,
	args: string[],
	capture: boolean,
): Promise<{ code: number; stdout: string }> {
	options.signal?.throwIfAborted();
	if (process.platform === "win32")
		throw new Error(
			"local CI requires a POSIX host for process-group cancellation",
		);
	const cwd = resolve(options.cwd);
	const turboPath =
		options.turboPath ??
		createRequire(resolve(cwd, "package.json")).resolve("turbo/bin/turbo");
	return new Promise((resolveResult, reject) => {
		const child = spawn(process.execPath, [turboPath, ...args], {
			cwd,
			env: {
				...process.env,
				TURBO_TELEMETRY_DISABLED: "1",
			},
			detached: true,
			stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		let escalation: NodeJS.Timeout | undefined;
		let hardStop: NodeJS.Timeout | undefined;
		function kill(signal: NodeJS.Signals) {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					failure = new Error("Turbo process-group shutdown failed", {
						cause: error,
					});
			}
		}
		function stop() {
			// A second interrupt asks Turbo's task manager to kill task groups
			// that ignore graceful shutdown. Keep Turbo alive long enough to reap.
			kill("SIGINT");
			escalation ??= setTimeout(() => kill("SIGINT"), 250);
			hardStop ??= setTimeout(() => {
				failure = new Error("Turbo shutdown could not be confirmed");
				kill("SIGKILL");
			}, 15_000);
		}
		const timeout = capture
			? setTimeout(() => {
					failure = new Error("Turbo planning exceeded 60 seconds");
					stop();
				}, 60_000)
			: undefined;
		function collect(chunk: Buffer, stream: "stdout" | "stderr") {
			bytes += chunk.length;
			if (bytes > 16 * 1024 * 1024) {
				failure = new Error("Turbo planning output exceeds 16 MiB");
				stop();
				return;
			}
			(stream === "stdout" ? stdout : stderr).push(chunk);
		}
		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			clearTimeout(escalation);
			clearTimeout(hardStop);
			kill("SIGKILL");
			options.signal?.removeEventListener("abort", stop);
			if (failure) reject(failure);
			else if (options.signal?.aborted) reject(options.signal.reason);
			else if (capture && code !== 0)
				reject(
					new Error(
						`Turbo planning failed: ${Buffer.concat(stderr).toString("utf8").trim() || Buffer.concat(stdout).toString("utf8").trim()}`,
					),
				);
			else
				resolveResult({
					code: code ?? 1,
					stdout: Buffer.concat(stdout).toString("utf8"),
				});
		});
		options.signal?.addEventListener("abort", stop, { once: true });
		if (options.signal?.aborted) stop();
	});
}

/** Select Vercel CI entrypoints, then let Turbo expand dependencies and affected scope. */
export async function planTurboCi(
	options: TurboCiOptions,
): Promise<TurboCiPlan> {
	if ((options.base || options.head) && !options.affected)
		throw new Error("base/head require affected mode");
	if (options.affected && !options.base)
		throw new Error("affected mode requires an explicit base commit");
	const version = (await command(options, ["--version"], true)).stdout.trim();
	const parsedVersion = /^2\.(\d+)\.(\d+)$/.exec(version);
	if (
		!parsedVersion ||
		Number(parsedVersion[1]) < 11 ||
		(Number(parsedVersion[1]) === 11 && Number(parsedVersion[2]) < 10)
	)
		throw new Error(`local CI requires Turbo >=2.11.10 <3 (found ${version})`);
	const response = graph.parse(
		JSON.parse((await command(options, ["query", query], true)).stdout),
	);
	let taskIds = [
		...new Set(
			response.data.packages.items.flatMap((pkg) =>
				pkg.tasks.items
					.filter(
						(task) => task.tags.includes("ci") && !task.tags.includes("!ci"),
					)
					.map((task) => task.fullName),
			),
		),
	].sort();
	if (options.affected && taskIds.length) {
		// Explicit package#task selectors bypass `turbo run --affected`. Resolve the
		// input-aware affected set first, then execute its CI entrypoints normally.
		const affectedQuery = `query { affectedTasks(base: ${JSON.stringify(options.base)}, head: ${JSON.stringify(options.head ?? "HEAD")}) { items { fullName } } }`;
		const affected = affectedGraph.parse(
			JSON.parse(
				(await command(options, ["query", affectedQuery], true)).stdout,
			),
		);
		const ids = new Set(
			affected.data.affectedTasks.items.map((task) => task.fullName),
		);
		taskIds = taskIds.filter((id) => ids.has(id));
	}
	if (!taskIds.length) return create(TurboCiPlanSchema);
	const runArgs = [
		"run",
		...taskIds,
		"--concurrency=100%",
		"--continue=never",
		options.remoteCache ? "--cache=local:rw,remote:rw" : "--cache=local:rw",
	];
	const planned = dryRun.parse(
		JSON.parse(
			(await command(options, [...runArgs, "--dry=json"], true)).stdout,
		),
	);
	const packageTags = new Map(
		response.data.packages.items.map((pkg) => [pkg.name, pkg.tags]),
	);
	const taskTags = new Map(
		response.data.packages.items.flatMap((pkg) =>
			pkg.tasks.items.map((task) => [task.fullName, task.tags] as const),
		),
	);
	for (const task of planned.tasks) {
		if (task.resolvedTaskDefinition.persistent)
			throw new Error(`local CI cannot run persistent task ${task.taskId}`);
		const taskOidc = (taskTags.get(task.taskId) ?? []).filter((tag) =>
			tag.startsWith("ci:oidc:"),
		);
		const oidc = taskOidc.length
			? taskOidc
			: (packageTags.get(task.taskId.split("#")[0] ?? "") ?? []).filter((tag) =>
					tag.startsWith("ci:oidc:"),
				);
		if (oidc.some((tag) => tag !== "ci:oidc:none"))
			throw new Error(
				`local CI cannot supply Vercel-managed OIDC for ${task.taskId}`,
			);
		if (task.taskId.endsWith("#deployment") && task.command === "<NONEXISTENT>")
			throw new Error(
				`local CI cannot wait for Vercel deployment ${task.taskId}`,
			);
	}
	return create(TurboCiPlanSchema, { taskIds, runArgs });
}

/** Stream the selected tasks' logs and return Turbo's exit code. No Vercel API calls. */
export async function runTurboCi(options: TurboCiOptions): Promise<number> {
	const plan = await planTurboCi(options);
	if (!plan.taskIds.length) return 0;
	return (await command(options, plan.runArgs, false)).code;
}
