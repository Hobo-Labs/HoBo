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

/** Decide whether an auto-routed batch needs the verified public fallback. */
export function mergeShardPolicy(input: {
	readonly event: string;
	readonly plan: string;
	readonly routingConfig?: string | undefined;
}): "unchanged" | "require-public" | "unavailable" {
	if (input.event !== "merge_group" || shardCount(input.plan) < 2)
		return "unchanged";
	const settings = routeSettings(readRunnerRouting(input.routingConfig));
	if (!settings.committed) return "unavailable";
	if (settings.pin !== "auto") return "unchanged";
	return settings.labels.github === "ubuntu-24.04"
		? "require-public"
		: "unavailable";
}

/** A pin or single shard keeps the first route. Pickup evidence alone does
 * not prove enough capacity for an automatic concurrent batch. */
export function mergeShardRunner(input: {
	readonly event: string;
	readonly plan: string;
	readonly publicRepository: boolean;
	readonly routingConfig?: string | undefined;
}): string | undefined {
	return mergeShardPolicy(input) === "require-public" && input.publicRepository
		? "ubuntu-24.04"
		: undefined;
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
	const policy = mergeShardPolicy({
		event: env.GITHUB_EVENT_NAME ?? "",
		plan: env.HOBO_PLANNED_SHARDS ?? "",
		routingConfig: config,
	});
	if (policy === "unchanged") return;
	if (policy === "unavailable")
		throw new Error(
			"merge-group shard routing policy or standard-runner price evidence is unavailable",
		);
	if (!(await isPublicCaller(env, send)))
		throw new Error(
			"merge-group public standard-runner compute evidence is unavailable",
		);
	const runner = "ubuntu-24.04";
	if (!env.GITHUB_OUTPUT) throw new Error("GitHub output is unavailable");
	appendFileSync(env.GITHUB_OUTPUT, `runner=${runner}\n`);
	console.log(
		`Merge-group shards use ${runner}: whole-batch fleet capacity was not verified.`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
