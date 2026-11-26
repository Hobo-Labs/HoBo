/**
 * Backup, migration, and maintenance as argv arrays.
 *
 * Same two rules as every pack operation: no shell, and no credential in argv.
 * The credential travels in `secretEnv` as a locator and is resolved into the
 * child environment at the moment of spawn, so a `ValkeyCommand` is safe to log,
 * to store in an event body, and to show a human in a plan.
 *
 * `REDISCLI_AUTH` is the environment variable used to authenticate the CLI. It is
 * inherited from `redis-cli`, and this pack has **not** verified it against a live
 * `valkey-cli` build (see README "Sources"). It is used here rather than
 * `--pass`/`-a` because those put the password in argv, where `ps` shows it to
 * every process on the host; if the variable turns out to be unsupported, the fix
 * is a different environment variable, not a move to argv.
 */
import type { SecretRef } from "@hobo/bindings";
import {
	assertArgvSafe,
	PackError,
	type PackSecretResolverPort,
	type ProcessResult,
	type ProcessRunner,
	resolveSecret,
} from "@hobo/pack-framework";

import { VALKEY_PORT } from "./image.js";
import { VALKEY_MIGRATION_PROFILE } from "./manifest.js";
import type { ValkeyDurabilityMode } from "./semantics.js";

declare const filePathBrand: unique symbol;

/** An absolute path with no traversal, for an RDB artifact. */
export type ValkeyFilePath = string & {
	readonly [filePathBrand]: "ValkeyFilePath";
};

const ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const HOSTNAME =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;

/** The environment variable `valkey-cli` reads a password from. See module note. */
// public-contract: environment key used by generated redis-cli operations.
export const VALKEY_CLI_AUTH_ENV = "REDISCLI_AUTH" as const;

function operationInvalid(detail: string): never {
	throw new PackError("PACK_OPERATION_FAILED", detail);
}

export function parseValkeyFilePath(
	input: string,
	what: string,
): ValkeyFilePath {
	if (!ABSOLUTE_PATH.test(input) || input.includes("..")) {
		operationInvalid(
			`${what} must be an absolute path with no traversal segments`,
		);
	}
	if (input.length > 4096)
		operationInvalid(`${what} exceeds the 4096 character path limit`);
	// SAFETY: `return input as ValkeyFilePath;` is required at this I/O or test boundary.
	return input as ValkeyFilePath;
}

export type ValkeyEndpointInput = {
	readonly host: string;
	readonly port?: number;
	/** Logical database index. `SELECT` space, not a named database. */
	readonly database?: number;
	readonly passwordRef: SecretRef;
	readonly tls?: boolean;
};

export type ValkeyEndpoint = {
	readonly host: string;
	readonly port: number;
	readonly database: number;
	readonly passwordRef: SecretRef;
	readonly tls: boolean;
};

/** The one parse boundary for an operation target. */
export function parseValkeyEndpoint(
	input: ValkeyEndpointInput,
): ValkeyEndpoint {
	if (!HOSTNAME.test(input.host) || input.host.length > 253) {
		operationInvalid("endpoint host must be a bare lowercase hostname");
	}
	const port = input.port ?? VALKEY_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		operationInvalid("endpoint port must be an integer between 1 and 65535");
	}
	const database = input.database ?? 0;
	if (!Number.isInteger(database) || database < 0 || database > 255) {
		operationInvalid("endpoint database must be an integer between 0 and 255");
	}
	return {
		host: input.host,
		port,
		database,
		passwordRef: input.passwordRef,
		tls: input.tls ?? false,
	};
}

export type ValkeyCommand = {
	readonly operationId: string;
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	/** Environment variable name to locator. Resolved only at spawn time. */
	readonly secretEnv: Readonly<Record<string, SecretRef>>;
	readonly timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function cliArgv(endpoint: ValkeyEndpoint): readonly string[] {
	return [
		"valkey-cli",
		"-h",
		endpoint.host,
		"-p",
		String(endpoint.port),
		"-n",
		String(endpoint.database),
		...(endpoint.tls ? ["--tls"] : []),
		// Fail instead of prompting: a CLI waiting on a terminal read inside a
		// container is indistinguishable from a hang.
		"--no-auth-warning",
	];
}

function command(
	operationId: string,
	endpoint: ValkeyEndpoint,
	rest: readonly string[],
	timeoutMs: number | undefined,
): ValkeyCommand {
	return {
		operationId,
		argv: assertArgvSafe([...cliArgv(endpoint), ...rest]),
		env: {},
		secretEnv: { [VALKEY_CLI_AUTH_ENV]: endpoint.passwordRef },
		timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

export type ValkeyRdbBackupOptions = {
	readonly endpoint: ValkeyEndpointInput;
	/** Where the RDB is written on the machine running the CLI. */
	readonly outputPath: string;
	readonly timeoutMs?: number;
};

/**
 * Ask the server for a fresh RDB over the protocol.
 *
 * Deliberately not "copy the file off the volume": in cache mode there is no file,
 * and in snapshot mode the file on disk is as old as the last save. `--rdb` makes
 * the server produce a current one, so the backup means the same thing in every
 * durability mode.
 */
export function buildValkeyRdbBackupArgv(
	options: ValkeyRdbBackupOptions,
): ValkeyCommand {
	const endpoint = parseValkeyEndpoint(options.endpoint);
	const outputPath = parseValkeyFilePath(
		options.outputPath,
		"backup output path",
	);
	return command(
		"valkey.backup.rdb-dump",
		endpoint,
		["--rdb", outputPath],
		options.timeoutMs,
	);
}

export function buildValkeyRewriteAofArgv(options: {
	readonly endpoint: ValkeyEndpointInput;
	readonly durabilityMode: ValkeyDurabilityMode;
	readonly timeoutMs?: number;
}): ValkeyCommand {
	if (
		options.durabilityMode !== "aof-everysec" &&
		options.durabilityMode !== "aof-always"
	) {
		// The server accepts BGREWRITEAOF with appendonly off and does nothing
		// useful. Reporting success for a no-op is how a maintenance schedule
		// ends up believing it is compacting a file that does not exist.
		operationInvalid(
			`BGREWRITEAOF is meaningless in durability mode ${options.durabilityMode}; no append-only file is being written`,
		);
	}
	const endpoint = parseValkeyEndpoint(options.endpoint);
	return command(
		"valkey.maintenance.rewrite-aof",
		endpoint,
		["BGREWRITEAOF"],
		options.timeoutMs,
	);
}

/**
 * A live keyspace handoff, as three observable steps.
 *
 * `replicate` points the target at the source. `awaitSync` asks the *target*
 * whether its initial sync finished — a real question with a real answer, rather
 * than a sleep. `promote` detaches it.
 *
 * The steps are separate commands because the middle one is the only place a
 * handoff can legitimately fail slowly, and a caller needs to be able to retry it
 * without re-issuing the other two.
 */
export type ValkeyHandoffPlan = {
	readonly profileRef: typeof VALKEY_MIGRATION_PROFILE;
	readonly replicate: ValkeyCommand;
	readonly awaitSync: ValkeyCommand;
	readonly promote: ValkeyCommand;
};

export type ValkeyHandoffOptions = {
	/** The server that currently owns the keyspace. */
	readonly source: ValkeyEndpointInput;
	/** The server that will own it. Receives every command in the plan. */
	readonly target: ValkeyEndpointInput;
	readonly timeoutMs?: number;
};

export function buildValkeyReplicaHandoffPlan(
	options: ValkeyHandoffOptions,
): ValkeyHandoffPlan {
	const source = parseValkeyEndpoint(options.source);
	const target = parseValkeyEndpoint(options.target);
	if (source.host === target.host && source.port === target.port) {
		operationInvalid(
			"handoff source and target are the same server; a server cannot replicate from itself",
		);
	}
	const timeoutMs = options.timeoutMs;
	return {
		profileRef: VALKEY_MIGRATION_PROFILE,
		replicate: command(
			"valkey.migration.replica-handoff",
			target,
			["REPLICAOF", source.host, String(source.port)],
			timeoutMs,
		),
		// `INFO replication` reports master_link_status:up once the initial sync
		// completed. The caller inspects stdout; this package does not parse it,
		// because a parser here would be a second place for the format to matter.
		awaitSync: command(
			"valkey.migration.replica-handoff",
			target,
			["INFO", "replication"],
			timeoutMs,
		),
		promote: command(
			"valkey.migration.replica-handoff",
			target,
			["REPLICAOF", "NO", "ONE"],
			timeoutMs,
		),
	};
}

/**
 * Run a command, resolving locators into the child environment at spawn time.
 *
 * The resolved value exists only inside this function's environment object: it is
 * never returned, never logged, and never placed in argv.
 */
export async function runValkeyCommand(
	runner: ProcessRunner,
	resolver: PackSecretResolverPort,
	cmd: ValkeyCommand,
): Promise<ProcessResult> {
	const env = { ...cmd.env };
	for (const [key, ref] of Object.entries(cmd.secretEnv)) {
		const value = await resolveSecret(resolver, ref);
		env[key] = value.expose();
	}
	// Re-assert immediately before spawning: a caller could have appended to
	// argv after the builder returned.
	assertArgvSafe(cmd.argv);
	return runner.run(cmd.argv, { env, timeoutMs: cmd.timeoutMs });
}
