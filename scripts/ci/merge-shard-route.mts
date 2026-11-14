#!/usr/bin/env node
/** Choose a merge-group shard batch before GitHub queues its jobs. */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { routeSettings } from "./route-runner.mts";
import {
	asObject,
	type JsonValue,
	readRunnerRouting,
} from "./runner-routing.mts";

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

/** Read the caller repository, rather than a reusable workflow's repository.
 * This point-in-time observation covers standard-runner compute pricing only;
 * it is not a budget admission or a guarantee of later visibility. */
export async function isPublicCaller(
	env: NodeJS.ProcessEnv,
	send: typeof fetch = fetch,
): Promise<boolean> {
	const repository = env.GITHUB_REPOSITORY ?? "";
	const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
	const ownerId = Number(env.GITHUB_REPOSITORY_OWNER_ID);
	const token = env.GITHUB_TOKEN ?? "";
	if (
		!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/u.test(repository) ||
		repository.split("/").some((part) => part === "." || part === "..") ||
		![repositoryId, ownerId].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		!token ||
		token.length > 4096 ||
		/[\r\n]/u.test(token)
	)
		return false;
	try {
		const response = await send(`https://api.github.com/repos/${repository}`, {
			method: "GET",
			redirect: "error",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(5_000),
		});
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel();
			return false;
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > 65_536) return false;
				chunks.push(part.value);
			}
		} finally {
			await reader.cancel();
		}
		// SAFETY: JSON.parse produces a JsonValue, which asObject narrows.
		const repo = asObject(
			JSON.parse(Buffer.concat(chunks).toString()) as JsonValue,
		);
		const owner = asObject(repo?.owner);
		return (
			repo?.id === repositoryId &&
			owner?.id === ownerId &&
			repo.private === false &&
			repo.visibility === "public" &&
			repo.disabled === false &&
			repo.archived === false
		);
	} catch {
		return false;
	}
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
