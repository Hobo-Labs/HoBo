#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
	AutoscalingRunnerSetSchema,
	arcRunnerCachePatch,
	storePrewarmJob,
} from "../../packages/ci-gh-actions/src/arc-runner-caches.ts";

export {
	AutoscalingRunnerSetSchema,
	arcRunnerCachePatch,
	CACHE_OWNER_INIT,
	NODE_CACHE_ROOT,
	POD_IMAGE_CACHE,
	POD_PNPM_STORE,
	RUNNER_UID,
	type RunnerPodSpec,
	runnerContainerIndex,
	storePrewarmJob,
	withRunnerCaches,
} from "../../packages/ci-gh-actions/src/arc-runner-caches.ts";

function kubectl(args: readonly string[], input?: string): string {
	const result = spawnSync("kubectl", [...args], {
		encoding: "utf8",
		input,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`kubectl ${args.slice(0, 2).join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`,
		);
	}
	return result.stdout;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export function runCli(args: readonly string[]): void {
	const name = flag(args, "--scale-set");
	const namespace = flag(args, "--namespace");
	if (!name || !namespace) {
		throw new Error(
			"usage: arc-runner-caches.mts --scale-set <name> --namespace <ns> [--apply] [--prewarm <owner/repo> <sha>]",
		);
	}
	const set = AutoscalingRunnerSetSchema.parse(
		JSON.parse(
			kubectl([
				"get",
				"autoscalingrunnerset",
				name,
				"--namespace",
				namespace,
				"--output",
				"json",
			]),
		),
	);
	const patch = arcRunnerCachePatch(set);
	console.log(JSON.stringify(patch, null, 2));
	const apply = args.includes("--apply");
	if (apply && patch.length > 0) {
		kubectl([
			"patch",
			"autoscalingrunnerset",
			name,
			"--namespace",
			namespace,
			"--type",
			"json",
			"--patch",
			JSON.stringify(patch),
		]);
		console.log(`patched ${namespace}/${name}: ${patch.length} operation(s)`);
	}
	const prewarmIndex = args.indexOf("--prewarm");
	if (prewarmIndex >= 0) {
		const job = storePrewarmJob(
			set,
			args[prewarmIndex + 1] ?? "",
			args[prewarmIndex + 2] ?? "",
		);
		if (apply) kubectl(["apply", "--filename", "-"], JSON.stringify(job));
		else console.log(JSON.stringify(job, null, 2));
	}
}

const invokedPath = process.argv[1];
if (
	invokedPath &&
	import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
	try {
		runCli(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
