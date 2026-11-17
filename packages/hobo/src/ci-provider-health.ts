/**
 * `hobo ci provider-health`: which hosted runner types the relay has stopped
 * routing to, and why; `clear <provider> <label>` lets one through again
 * (ADR-0183).
 *
 * A hosted runner type that misses three jobs inside thirty minutes is
 * tripped and passed over until a trial job starts. The record lives in the
 * relay's provider-health file, so this command reads and edits that file:
 * `--db <path>`, else `HOBO_CI_PROVIDER_HEALTH_DB`, else
 * `$HOBO_HOME/ci/serve/provider-health.sqlite`. Listing never creates the
 * file.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	HOSTED_RUNNER_PROVIDERS,
	type ProviderHealthRecord,
	providerHealthKey,
	providerHealthOf,
	providerHealthState,
} from "@hobo/ci";
import { SqliteProviderHealthStore } from "@hobo/ci/runner-order/provider-health-sqlite";
import type { CommandResult } from "@hobo/cli";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import { defaultHoboHome } from "./hobo-home.js";

const USAGE =
	"Usage: hobo ci provider-health [--db <path>]\n       hobo ci provider-health clear <provider> <label> [--db <path>]";

/** The provider-health file this command reads: the flag, the environment, then the serve state dir. */
export function providerHealthDbPath(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): string {
	const flag = args.indexOf("--db");
	const given = flag >= 0 ? args[flag + 1] : undefined;
	if (given) return given;
	const fromEnv = env.HOBO_CI_PROVIDER_HEALTH_DB;
	if (fromEnv) return fromEnv;
	return join(defaultHoboHome(env), "ci", "serve", "provider-health.sqlite");
}

function positional(args: readonly string[]): readonly string[] {
	const words: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--db") index += 1;
		else if (!word.startsWith("--")) words.push(word);
	}
	return words;
}

function iso(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** One record as the command prints and returns it. */
export function providerHealthRow(record: ProviderHealthRecord, nowMs: number) {
	const health = providerHealthOf(record);
	return {
		key: record.key,
		state: providerHealthState(health, nowMs),
		misses: health.outcomes.filter((outcome) => !outcome.started).length,
		trippedAt: iso(health.trippedAtMs),
		nextTrialAt: iso(health.nextTrialAtMs),
		backoffMinutes: Math.round(health.backoffMs / 60_000),
	};
}

async function list(path: string, nowMs: number): Promise<CommandResult> {
	if (!existsSync(path))
		return {
			message: `No provider health recorded yet (${path}).`,
			data: { path, providers: [] },
		};
	const store = new SqliteProviderHealthStore(path);
	try {
		const rows = (await store.list()).map((record) =>
			providerHealthRow(record, nowMs),
		);
		const lines = rows.map((row) =>
			row.state === "healthy"
				? `${row.key}: healthy`
				: `${row.key}: ${row.state}, tripped ${row.trippedAt ?? "?"}, next trial ${row.nextTrialAt ?? "?"}`,
		);
		return {
			message:
				rows.length === 0
					? `No provider health recorded yet (${path}).`
					: lines.join("\n"),
			data: { path, providers: rows },
		};
	} finally {
		store.close();
	}
}

async function clear(
	path: string,
	provider: string,
	label: string,
): Promise<CommandResult> {
	const known = HOSTED_RUNNER_PROVIDERS.find((entry) => entry === provider);
	if (!known)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CLI_USAGE",
			message: `"${provider}" is not a hosted provider. Use one of: ${HOSTED_RUNNER_PROVIDERS.join(", ")}.`,
		};
	const key = providerHealthKey(known, label);
	if (!existsSync(path))
		return {
			message: `${key} has no record to clear; it is healthy.`,
			data: { path, key, cleared: false },
		};
	const store = new SqliteProviderHealthStore(path);
	try {
		const cleared = await store.clear(key);
		return {
			message: cleared
				? `Cleared ${key}; the next job may use it.`
				: `${key} has no record to clear; it is healthy.`,
			data: { path, key, cleared },
		};
	} finally {
		store.close();
	}
}

async function run(context: CiCommandContext): Promise<CommandResult> {
	const path = providerHealthDbPath(context.args, context.env);
	const words = positional(context.args);
	if (words.length === 0) return list(path, context.now());
	const [verb, provider, label] = words;
	if (verb === "clear" && provider && label && words.length === 3)
		return clear(path, provider.toLowerCase(), label);
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message: USAGE };
}

export const CI_PROVIDER_HEALTH_COMMAND: CiCommand = {
	name: "provider-health",
	summary:
		"List hosted runner types the relay has stopped routing to; clear <provider> <label> lets one through again.",
	run,
};
