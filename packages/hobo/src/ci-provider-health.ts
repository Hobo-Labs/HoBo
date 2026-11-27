import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	HOSTED_RUNNER_PROVIDERS,
	type ProviderHealthRecord,
	providerHealthKey,
	providerHealthOf,
	providerHealthState,
} from "@hobo/ci";
import {
	readProviderHealthRecords,
	SqliteProviderHealthStore,
} from "@hobo/ci/runner-order/provider-health-sqlite";
import type { CommandResult } from "@hobo/cli";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import { defaultHoboHome } from "./hobo-home.js";

const USAGE =
	"Usage: hobo ci provider-health [--db <path>]\n       hobo ci provider-health clear <provider> [<label>] [--db <path>]";

type ParsedProviderHealthArgs =
	| Readonly<{ ok: true; db: string | undefined; words: readonly string[] }>
	| Readonly<{ ok: false; message: string }>;

function parseProviderHealthArgs(
	args: readonly string[],
): ParsedProviderHealthArgs {
	const words: string[] = [];
	let db: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--json") continue;
		if (word === "--db") {
			const next = args[index + 1];
			if (!next || next.startsWith("--")) {
				return { ok: false, message: `--db requires a file path.\n${USAGE}` };
			}
			db = next;
			index += 1;
			continue;
		}
		if (word.startsWith("--db=")) {
			const value = word.slice("--db=".length);
			if (value.length === 0) {
				return { ok: false, message: `--db requires a file path.\n${USAGE}` };
			}
			db = value;
			continue;
		}
		if (word.startsWith("--")) {
			return { ok: false, message: `Unknown option "${word}".\n${USAGE}` };
		}
		words.push(word);
	}
	return { ok: true, db, words };
}

export function providerHealthDbPath(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): string {
	const parsed = parseProviderHealthArgs(args);
	if (parsed.ok && parsed.db) return parsed.db;
	const fromEnv = env.HOBO_CI_PROVIDER_HEALTH_DB;
	if (fromEnv) return fromEnv;
	return join(defaultHoboHome(env), "ci", "serve", "provider-health.sqlite");
}

function iso(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

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
	const rows = readProviderHealthRecords(path).map((record) =>
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
}

async function clear(
	path: string,
	provider: string,
	label: string | undefined,
): Promise<CommandResult> {
	const known = HOSTED_RUNNER_PROVIDERS.find((entry) => entry === provider);
	if (!known)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CLI_USAGE",
			message: `"${provider}" is not a hosted provider. Use one of: ${HOSTED_RUNNER_PROVIDERS.join(", ")}.`,
		};
	if (label !== undefined) {
		if (label.trim().length === 0)
			return {
				ok: false,
				status: "usage",
				code: "HOBO_CLI_USAGE",
				message: USAGE,
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
	if (!existsSync(path))
		return {
			message: `${known} has no record to clear; it is healthy.`,
			data: { path, provider: known, clearedKeys: [], cleared: false },
		};
	const prefix = `${known}:`;
	const store = new SqliteProviderHealthStore(path);
	const clearedKeys: string[] = [];
	try {
		const keys = (await store.list())
			.map((record) => record.key)
			.filter((key) => key.startsWith(prefix));
		for (const key of keys) {
			if (await store.clear(key)) clearedKeys.push(key);
		}
		return {
			message:
				clearedKeys.length > 0
					? `Cleared ${clearedKeys.join(", ")}; the next job may use ${known}.`
					: `${known} has no record to clear; it is healthy.`,
			data: {
				path,
				provider: known,
				clearedKeys,
				cleared: clearedKeys.length > 0,
			},
		};
	} finally {
		store.close();
	}
}

async function run(context: CiCommandContext): Promise<CommandResult> {
	const parsed = parseProviderHealthArgs(context.args);
	if (!parsed.ok) {
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CLI_USAGE",
			message: parsed.message,
		};
	}
	const path =
		parsed.db ??
		context.env.HOBO_CI_PROVIDER_HEALTH_DB ??
		join(defaultHoboHome(context.env), "ci", "serve", "provider-health.sqlite");
	const words = parsed.words;
	if (words.length === 0) return list(path, context.now());
	const [verb, provider, label] = words;
	if (
		verb === "clear" &&
		provider &&
		(words.length === 2 || words.length === 3)
	)
		return clear(path, provider.toLowerCase(), label);
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message: USAGE };
}

export const CI_PROVIDER_HEALTH_COMMAND: CiCommand = {
	name: "provider-health",
	summary:
		"List hosted runner types the relay has stopped routing to; clear <provider> [<label>] lets them through again.",
	run,
};
