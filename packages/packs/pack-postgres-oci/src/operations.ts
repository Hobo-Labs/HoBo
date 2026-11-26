/**
 * Backup, restore, and migration as argv arrays.
 *
 * Two rules drive every decision in this module:
 *
 * 1. **No shell.** Each operation is a `readonly string[]` handed to an injected
 *    `ProcessRunner`. There is no concatenation and no interpolation, so a
 *    database called `x"; DROP` is a single inert argument.
 * 2. **No credential in argv.** A password on a command line is visible in `ps`
 *    to every user on the host. `PostgresCommand.secretEnv` therefore carries
 *    *locators*, and {@link runPostgresCommand} resolves them into the child
 *    environment at the moment of spawn — the command object itself never holds
 *    plaintext, so it is safe to log, store in an event, or put in a plan.
 *
 * A migration is returned as a dump command plus a restore command rather than a
 * pipeline, because a pipeline needs a shell and hides the exit status of its
 * first process.
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

declare const identifierBrand: unique symbol;
declare const filePathBrand: unique symbol;

/**
 * A PostgreSQL identifier restricted to the unquoted, lowercase-safe subset.
 *
 * PostgreSQL itself accepts far more through double quoting. This narrower
 * grammar is a deliberate choice: the extra names are worth less than the
 * guarantee that an identifier can be placed in argv, in a connection string, and
 * in a `psql` command without a quoting rule per destination.
 */
export type PostgresIdentifier = string & {
	readonly [identifierBrand]: "PostgresIdentifier";
};

/** An absolute path with no traversal, for a dump file or a password file. */
export type PostgresFilePath = string & {
	readonly [filePathBrand]: "PostgresFilePath";
};

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const HOSTNAME =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;

function operationInvalid(detail: string): never {
	throw new PackError("PACK_OPERATION_FAILED", detail);
}

export function parsePostgresIdentifier(
	input: string,
	what: string,
): PostgresIdentifier {
	if (!IDENTIFIER.test(input)) {
		operationInvalid(
			`${what} must be a lowercase unquoted PostgreSQL identifier of 1-63 characters`,
		);
	}
	// `pg_` is reserved for the system catalogs; a role or database in that
	// namespace is either a mistake or an attempt to shadow something.
	if (input.startsWith("pg_")) {
		operationInvalid(`${what} must not use the reserved pg_ prefix`);
	}
	// SAFETY: `return input as PostgresIdentifier;` is required at this I/O or test boundary.
	return input as PostgresIdentifier;
}

export function parsePostgresFilePath(
	input: string,
	what: string,
): PostgresFilePath {
	if (!ABSOLUTE_PATH.test(input) || input.includes("..")) {
		operationInvalid(
			`${what} must be an absolute path with no traversal segments`,
		);
	}
	if (input.length > 4096)
		operationInvalid(`${what} exceeds the 4096 character path limit`);
	// SAFETY: `return input as PostgresFilePath;` is required at this I/O or test boundary.
	return input as PostgresFilePath;
}

export const POSTGRES_SSL_MODES = [
	"disable",
	"require",
	"verify-ca",
	"verify-full",
] as const;

export type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

export type PostgresEndpointInput = {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly role: string;
	readonly sslMode: PostgresSslMode;
	/** Locator for the role's password. Resolved only at spawn time. */
	readonly passwordRef: SecretRef;
};

export type PostgresEndpoint = {
	readonly host: string;
	readonly port: number;
	readonly database: PostgresIdentifier;
	readonly role: PostgresIdentifier;
	readonly sslMode: PostgresSslMode;
	readonly passwordRef: SecretRef;
};

/** The one parse boundary for an operation target. */
export function parsePostgresEndpoint(
	input: PostgresEndpointInput,
): PostgresEndpoint {
	if (!HOSTNAME.test(input.host) || input.host.length > 253) {
		operationInvalid("endpoint host must be a bare lowercase hostname");
	}
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
		operationInvalid("endpoint port must be an integer between 1 and 65535");
	}
	// SAFETY: `if (!(POSTGRES_SSL_MODES as readonly string[]).includes(input.sslMode)) {` is required at this I/O or test boundary.
	if (!(POSTGRES_SSL_MODES as readonly string[]).includes(input.sslMode)) {
		operationInvalid(
			`unknown sslMode ${JSON.stringify(String(input.sslMode))}`,
		);
	}
	return {
		host: input.host,
		port: input.port,
		database: parsePostgresIdentifier(input.database, "endpoint database"),
		role: parsePostgresIdentifier(input.role, "endpoint role"),
		sslMode: input.sslMode,
		passwordRef: input.passwordRef,
	};
}

/**
 * A command that is ready to run and contains no secret material.
 *
 * `secretEnv` maps an environment variable name to a locator. The runner resolves
 * it; nothing upstream of the spawn ever holds the value.
 */
export type PostgresCommand = {
	readonly operationId: string;
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly secretEnv: Readonly<Record<string, SecretRef>>;
	readonly timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function connectionArgv(endpoint: PostgresEndpoint): readonly string[] {
	return [
		"--host",
		endpoint.host,
		"--port",
		String(endpoint.port),
		"--username",
		endpoint.role,
		"--dbname",
		endpoint.database,
		// Never prompt. A tool that blocks on a terminal read inside a container
		// looks exactly like a hang.
		"--no-password",
	];
}

// A `type` alias rather than an `interface`, so it keeps an implicit index
// signature and stays assignable to the `Readonly<Record<string, string>>` the
// process-env fields expect. An interface has no such signature, which is why
// naming these four variables made the value stop fitting where it is used --
// the same reason the provider manifests give for their own alias.
type PostgresClientEnv = {
	PGSSLMODE: string;
	PGCLIENTENCODING: string;
	LC_ALL: string;
	PAGER: string;
};

function baseEnv(endpoint: PostgresEndpoint): PostgresClientEnv {
	return {
		PGSSLMODE: endpoint.sslMode,
		// Deterministic client behaviour: no ~/.psqlrc, no locale-dependent
		// message parsing, no pager waiting for a terminal that does not exist.
		PGCLIENTENCODING: "UTF8",
		LC_ALL: "C",
		PAGER: "cat",
	};
}

export type PgDumpOptions = {
	readonly endpoint: PostgresEndpointInput;
	/** Where the dump is written. Must be absolute. */
	readonly outputPath: string;
	/**
	 * `custom` is compressed and restorable selectively; `directory` supports a
	 * parallel dump. `plain` is offered for a human-readable artifact.
	 */
	readonly format?: "custom" | "directory" | "plain";
	readonly schemaOnly?: boolean;
	readonly timeoutMs?: number;
};

export function buildPgDumpArgv(options: PgDumpOptions): PostgresCommand {
	const endpoint = parsePostgresEndpoint(options.endpoint);
	const outputPath = parsePostgresFilePath(
		options.outputPath,
		"dump output path",
	);
	const format = options.format ?? "custom";
	const argv = [
		"pg_dump",
		...connectionArgv(endpoint),
		`--format=${format}`,
		"--file",
		outputPath,
		...(options.schemaOnly === true ? ["--schema-only"] : []),
	];
	return {
		operationId: "postgres.backup.pg-dump",
		argv: assertArgvSafe(argv),
		env: baseEnv(endpoint),
		secretEnv: { PGPASSWORD: endpoint.passwordRef },
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

export type PgRestoreOptions = {
	readonly endpoint: PostgresEndpointInput;
	readonly inputPath: string;
	/**
	 * Drop objects before recreating them. Off by default: a restore that
	 * silently drops existing data is not a safe default.
	 */
	readonly clean?: boolean;
	/**
	 * Restore ownership and grants as recorded in the dump. Off by default,
	 * because the destination server usually has different role names — this is
	 * the flag a cross-server migration needs cleared.
	 */
	readonly preserveOwnership?: boolean;
	readonly timeoutMs?: number;
};

export function buildPgRestoreArgv(options: PgRestoreOptions): PostgresCommand {
	const endpoint = parsePostgresEndpoint(options.endpoint);
	const inputPath = parsePostgresFilePath(
		options.inputPath,
		"restore input path",
	);
	const argv = [
		"pg_restore",
		...connectionArgv(endpoint),
		// Stop at the first error instead of leaving a half-restored database
		// behind and exiting 0 with warnings.
		"--exit-on-error",
		"--single-transaction",
		...(options.clean === true ? ["--clean", "--if-exists"] : []),
		...(options.preserveOwnership === true
			? []
			: ["--no-owner", "--no-privileges"]),
		inputPath,
	];
	return {
		operationId: "postgres.restore.pg-restore",
		argv: assertArgvSafe(argv),
		env: baseEnv(endpoint),
		secretEnv: { PGPASSWORD: endpoint.passwordRef },
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

export function buildVacuumAnalyzeArgv(options: {
	readonly endpoint: PostgresEndpointInput;
	readonly timeoutMs?: number;
}): PostgresCommand {
	const endpoint = parsePostgresEndpoint(options.endpoint);
	const argv = [
		"psql",
		...connectionArgv(endpoint),
		"--set=ON_ERROR_STOP=1",
		"--no-psqlrc",
		// A fixed SQL literal. No caller input reaches this element, which is why
		// it is allowed to be SQL at all.
		"--command",
		"VACUUM ANALYZE",
	];
	return {
		operationId: "postgres.maintenance.vacuum-analyze",
		argv: assertArgvSafe(argv),
		env: baseEnv(endpoint),
		secretEnv: { PGPASSWORD: endpoint.passwordRef },
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

export type PostgresMigrationPlan = {
	readonly profileRef: "migration.postgres.pg-dump/v1";
	readonly dump: PostgresCommand;
	readonly restore: PostgresCommand;
	/** The intermediate artifact both commands reference. */
	readonly artifactPath: PostgresFilePath;
};

export type PgDumpMigrationOptions = {
	readonly source: PostgresEndpointInput;
	readonly target: PostgresEndpointInput;
	/** Path both steps use. Must be reachable from wherever the runner executes. */
	readonly artifactPath: string;
	readonly timeoutMs?: number;
};

/**
 * A dump/restore migration as two commands.
 *
 * Refuses a migration whose source and target are the same database on the same
 * server: that is either a typo or a request to restore a database over itself,
 * and both deserve an error rather than a destructive no-op.
 */
export function buildPgDumpMigrationPlan(
	options: PgDumpMigrationOptions,
): PostgresMigrationPlan {
	const source = parsePostgresEndpoint(options.source);
	const target = parsePostgresEndpoint(options.target);
	if (
		source.host === target.host &&
		source.port === target.port &&
		source.database === target.database
	) {
		operationInvalid(
			"migration source and target are the same database on the same server; nothing would move",
		);
	}
	const artifactPath = parsePostgresFilePath(
		options.artifactPath,
		"migration artifact path",
	);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		profileRef: "migration.postgres.pg-dump/v1",
		artifactPath,
		dump: {
			...buildPgDumpArgv({
				endpoint: options.source,
				outputPath: artifactPath,
				timeoutMs,
			}),
			operationId: "postgres.migration.pg-dump",
		},
		restore: {
			...buildPgRestoreArgv({
				endpoint: options.target,
				inputPath: artifactPath,
				timeoutMs,
			}),
			operationId: "postgres.migration.pg-dump",
		},
	};
}

/**
 * Run a command, resolving locators into the child environment at spawn time.
 *
 * The resolved value exists only inside this function's environment object. It is
 * never returned, never logged, and never placed in argv, and a non-zero exit
 * reports stderr through {@link PackError} only after the caller has had the
 * chance to redact it.
 */
export async function runPostgresCommand(
	runner: ProcessRunner,
	resolver: PackSecretResolverPort,
	command: PostgresCommand,
): Promise<ProcessResult> {
	const env = { ...command.env };
	for (const [key, ref] of Object.entries(command.secretEnv)) {
		const value = await resolveSecret(resolver, ref);
		env[key] = value.expose();
	}
	// Re-assert immediately before spawning: this is the last point at which a
	// caller could have appended to argv after the builder returned.
	assertArgvSafe(command.argv);
	return runner.run(command.argv, { env, timeoutMs: command.timeoutMs });
}
