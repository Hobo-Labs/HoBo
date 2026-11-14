#!/usr/bin/env node
/** Choose a merge-group shard batch before GitHub queues its jobs. */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPublicCaller, routeSettings } from "./route-runner.mts";
export { isPublicCaller } from "./route-runner.mts";
import { readRunnerRouting } from "./runner-routing.mts";

/** A malformed plan is treated as the full eight-shard fan-out. */
export function shardCount(plan: string): number {
	if (
		plan.length > 128 ||
		!/^\[\s*[0-7](?:\s*,\s*[0-7]){0,7}\s*\]$/u.test(plan)
	)
		return 8;
	const shards = plan.match(/[0-7]/gu) ?? [];
	return new Set(shards).size === shards.length ? shards.length : 8;
}

/** An explicit pin or a single shard keeps the first route. The existing
 * pickup evidence does not prove enough capacity for a whole concurrent
 * batch, so an automatic fan-out uses the configured GitHub fallback. */
export function mergeShardRunner(input: {
	readonly event: string;
	readonly plan: string;
	readonly publicRepository: boolean;
	readonly routingConfig?: string | undefined;
}): string | undefined {
	if (input.event !== "merge_group") return undefined;
	const settings = routeSettings(readRunnerRouting(input.routingConfig));
	if (
		!settings.committed ||
		settings.pin !== "auto" ||
		shardCount(input.plan) < 2 ||
		!input.publicRepository ||
		settings.labels.github !== "ubuntu-24.04"
	)
		return undefined;
	return settings.labels.github;
}

export async function main(
	env: NodeJS.ProcessEnv = process.env,
	send: typeof fetch = fetch,
): Promise<void> {
	let config: string | undefined;
	try {
		config = readFileSync(".hobo/ci.json", "utf8");
	} catch {
		config = undefined;
	}
	const runner = mergeShardRunner({
		event: env.GITHUB_EVENT_NAME ?? "",
		plan: env.HOBO_PLANNED_SHARDS ?? "",
		publicRepository: true,
		routingConfig: config,
	});
	if (!runner) return;
	if (!(await isPublicCaller(env, send))) {
		console.log(
			"Public caller repository was not verified; keeping the original shard route.",
		);
		return;
	}
	if (!env.GITHUB_OUTPUT) throw new Error("GitHub output is unavailable");
	appendFileSync(env.GITHUB_OUTPUT, `runner=${runner}\n`);
	console.log(
		`Merge-group shards use ${runner}: whole-batch fleet capacity was not verified.`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
