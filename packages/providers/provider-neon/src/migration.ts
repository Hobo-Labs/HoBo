/**
 * `migration.postgres.pg-dump/v1` and `migration.postgres.logical-copy/v1`.
 *
 * Two rules hold this together and neither is negotiable:
 *
 * - Every external command is an argv array handed to an injected
 *   {@link ProcessRunner}. There is no shell, no string concatenation, and no
 *   interpolation, so a database named `x; rm -rf /` is one inert argv element
 *   rather than a second command.
 * - Credentials reach the child through the environment (libpq `PGPASSWORD`)
 *   or stdin, never argv. `--dbname=<uri>` would be the convenient call and it
 *   is the one that puts the password in `ps` output for every user on the box.
 */
import type { SecretRef } from "@hobo/bindings";

import { parsePostgresConnectionUri } from "./connection-string.js";
import { resolveSecret, type SecretResolverPort } from "./custody.js";
import {
	containsControlChar,
	NeonProviderError,
	redactProviderText,
} from "./errors.js";

export type ProcessRunOptions = {
	readonly env: Readonly<Record<string, string>>;
	readonly stdin?: string;
	readonly timeoutMs: number;
	readonly cwd?: string;
};

export type ProcessResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Implementations MUST spawn without a shell (`shell: false`) and MUST NOT
 * inherit the ambient environment beyond what `env` provides.
 */
export interface ProcessRunner {
	run(
		argv: readonly string[],
		options: ProcessRunOptions,
	): Promise<ProcessResult>;
}

export const PG_DUMP_FORMATS = ["custom", "directory", "tar", "plain"] as const;

export type PgDumpFormat = (typeof PG_DUMP_FORMATS)[number];

export type PostgresTarget = {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly username: string;
	readonly sslMode: "require" | "verify-full" | "prefer";
};

export type PgDumpSpec = {
	readonly target: PostgresTarget;
	readonly filePath: string;
	readonly format: PgDumpFormat;
	readonly schemaOnly?: boolean;
	readonly dataOnly?: boolean;
	readonly noOwner?: boolean;
	readonly binary?: string;
};

export type PgRestoreSpec = {
	readonly target: PostgresTarget;
	readonly filePath: string;
	readonly noOwner?: boolean;
	readonly cleanFirst?: boolean;
	readonly binary?: string;
};

/**
 * Argv elements are inert, but a value containing NUL truncates in `execve`
 * and a value containing a newline forges log lines, so both are refused.
 */
function assertArgvValue(value: string, what: string): string {
	if (value.length === 0 || value.length > 1024) {
		throw new NeonProviderError(
			"MIGRATION_FAILED",
			`${what} must be 1-1024 characters`,
		);
	}
	if (containsControlChar(value)) {
		throw new NeonProviderError(
			"MIGRATION_FAILED",
			`${what} contains a control character and cannot be passed to a child process`,
		);
	}
	return value;
}

/**
 * Credential shapes refused in a command line; exported so a test can sweep
 * each for linear growth.
 */
export const ARGV_CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/postgres(?:ql)?:\/\//i,
	/\bnpg_[A-Za-z0-9_-]{4,}/u,
	/(?:^|[=\s])(?:--)?password[=\s]/i,
	/\/\/[^/\s:@]+:[^/\s:@]+@/u,
];

/** Last line of defence before a command is spawned. */
export function assertArgvSafe(argv: readonly string[]): readonly string[] {
	if (argv.length === 0) {
		throw new NeonProviderError(
			"MIGRATION_FAILED",
			"refusing to run an empty argv",
		);
	}
	for (const element of argv) {
		assertArgvValue(element, "argv element");
		for (const pattern of ARGV_CREDENTIAL_PATTERNS) {
			if (pattern.test(element)) {
				throw new NeonProviderError(
					"MIGRATION_FAILED",
					"refusing to place credential-shaped material in argv; pass it through the environment or stdin",
				);
			}
		}
	}
	return argv;
}

function targetArgv(target: PostgresTarget): readonly string[] {
	// Fused `--flag=value` form throughout: a value that begins with `-` can
	// never be re-read by the child as a flag of its own.
	return [
		`--host=${assertArgvValue(target.host, "host")}`,
		`--port=${String(target.port)}`,
		`--username=${assertArgvValue(target.username, "username")}`,
		`--dbname=${assertArgvValue(target.database, "database name")}`,
		"--no-password",
	];
}

export function buildPgDumpArgv(spec: PgDumpSpec): readonly string[] {
	if (spec.schemaOnly === true && spec.dataOnly === true) {
		throw new NeonProviderError(
			"MIGRATION_FAILED",
			"pg_dump cannot be both schema-only and data-only",
		);
	}
	const argv = [
		assertArgvValue(spec.binary ?? "pg_dump", "pg_dump binary"),
		...targetArgv(spec.target),
		`--format=${spec.format}`,
		`--file=${assertArgvValue(spec.filePath, "dump file path")}`,
		...(spec.schemaOnly === true ? ["--schema-only"] : []),
		...(spec.dataOnly === true ? ["--data-only"] : []),
		...(spec.noOwner === true ? ["--no-owner", "--no-acl"] : []),
	];
	return assertArgvSafe(argv);
}

export function buildPgRestoreArgv(spec: PgRestoreSpec): readonly string[] {
	const argv = [
		assertArgvValue(spec.binary ?? "pg_restore", "pg_restore binary"),
		...targetArgv(spec.target),
		...(spec.noOwner === true ? ["--no-owner", "--no-acl"] : []),
		...(spec.cleanFirst === true ? ["--clean", "--if-exists"] : []),
		assertArgvValue(spec.filePath, "dump file path"),
	];
	return assertArgvSafe(argv);
}

export function buildPsqlArgv(
	target: PostgresTarget,
	binary = "psql",
): readonly string[] {
	const argv = [
		assertArgvValue(binary, "psql binary"),
		...targetArgv(target),
		"--no-psqlrc",
		"--quiet",
		"--set=ON_ERROR_STOP=1",
		"--file=-",
	];
	return assertArgvSafe(argv);
}

/** libpq environment. The password is the only secret and it is only here. */
export function libpqEnv(
	target: PostgresTarget,
	password: string,
): Readonly<Record<string, string>> {
	return Object.freeze({
		PGHOST: target.host,
		PGPORT: String(target.port),
		PGUSER: target.username,
		PGDATABASE: target.database,
		PGPASSWORD: password,
		PGSSLMODE: target.sslMode,
		PGCONNECT_TIMEOUT: "15",
	});
}

export type MigrationOutcome = {
	readonly ok: boolean;
	readonly code: number;
	readonly argv: readonly string[];
	/** Redacted child stderr, safe for a receipt. */
	readonly stderr: string;
};

export type LogicalCopyPlan = {
	readonly profile: "migration.postgres.logical-copy/v1";
	readonly publicationName: string;
	readonly subscriptionName: string;
	readonly sourceStatements: readonly string[];
	readonly destinationStatementsRequireDsn: true;
};

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

/**
 * Build the source-side statements for a logical-replication copy.
 *
 * The destination side needs `CREATE SUBSCRIPTION ... CONNECTION '<dsn>'`,
 * which embeds a credential in SQL text. That statement is therefore never
 * assembled here; the caller composes it inside the resolved-secret scope and
 * sends it on stdin.
 */
export function buildLogicalCopyPlan(input: {
	readonly publicationName: string;
	readonly subscriptionName: string;
	readonly tables?: readonly string[];
	readonly logicalReplicationEnabled: boolean;
}): LogicalCopyPlan {
	if (!input.logicalReplicationEnabled) {
		throw new NeonProviderError(
			"MIGRATION_FAILED",
			"logical copy needs a database created with enable_logical_replication=true; Neon cannot turn it on for an existing claimable database",
		);
	}
	for (const name of [input.publicationName, input.subscriptionName]) {
		if (!SQL_IDENTIFIER.test(name)) {
			throw new NeonProviderError(
				"MIGRATION_FAILED",
				"publication and subscription names must be plain lowercase SQL identifiers",
			);
		}
	}
	for (const table of input.tables ?? []) {
		if (!SQL_IDENTIFIER.test(table)) {
			throw new NeonProviderError(
				"MIGRATION_FAILED",
				"table names for a logical copy must be plain lowercase SQL identifiers",
			);
		}
	}
	const scope =
		input.tables === undefined || input.tables.length === 0
			? "FOR ALL TABLES"
			: `FOR TABLE ${input.tables.join(", ")}`;
	return {
		profile: "migration.postgres.logical-copy/v1",
		publicationName: input.publicationName,
		subscriptionName: input.subscriptionName,
		sourceStatements: [`CREATE PUBLICATION ${input.publicationName} ${scope};`],
		destinationStatementsRequireDsn: true,
	};
}

export type MigrationDriverOptions = {
	readonly runner: ProcessRunner;
	readonly resolver: SecretResolverPort;
	readonly defaultTimeoutMs?: number;
};

export type PostgresMigrationDriver = {
	dump(input: {
		readonly credentialRef: SecretRef;
		readonly filePath: string;
		readonly format?: PgDumpFormat;
		readonly schemaOnly?: boolean;
		readonly noOwner?: boolean;
		readonly timeoutMs?: number;
	}): Promise<MigrationOutcome>;
	restore(input: {
		readonly credentialRef: SecretRef;
		readonly filePath: string;
		readonly noOwner?: boolean;
		readonly cleanFirst?: boolean;
		readonly timeoutMs?: number;
	}): Promise<MigrationOutcome>;
	applySourceStatements(input: {
		readonly credentialRef: SecretRef;
		readonly statements: readonly string[];
		readonly timeoutMs?: number;
	}): Promise<MigrationOutcome>;
};

async function targetFromRef(
	resolver: SecretResolverPort,
	ref: SecretRef,
): Promise<{ readonly target: PostgresTarget; readonly password: string }> {
	const secret = await resolveSecret(resolver, ref);
	const uri = secret.expose();
	const parts = parsePostgresConnectionUri(uri);
	const password = new URL(uri).password;
	if (password === "") {
		throw new NeonProviderError(
			"MIGRATION_FAILED",
			"the resolved connection string carries no password",
		);
	}
	const sslModeParameter = parts.parameters.sslmode;
	return {
		target: {
			host: parts.host,
			port: parts.port,
			database: parts.database,
			username: parts.username,
			sslMode:
				sslModeParameter === "verify-full"
					? "verify-full"
					: sslModeParameter === "prefer"
						? "prefer"
						: "require",
		},
		password: decodeURIComponent(password),
	};
}

export function createPostgresMigrationDriver(
	options: MigrationDriverOptions,
): PostgresMigrationDriver {
	const defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;

	async function run(
		argv: readonly string[],
		env: Readonly<Record<string, string>>,
		timeoutMs: number,
		stdin?: string,
	): Promise<MigrationOutcome> {
		const result = await options.runner.run(assertArgvSafe(argv), {
			env,
			timeoutMs,
			...(stdin !== undefined ? { stdin } : undefined),
		});
		const stderr = redactProviderText(result.stderr, 512);
		if (result.code !== 0) {
			throw new NeonProviderError(
				"MIGRATION_FAILED",
				`${argv[0] ?? "migration"} exited with code ${result.code}: ${stderr}`,
				{ detail: { code: result.code, command: argv[0] ?? "" } },
			);
		}
		return { ok: true, code: result.code, argv, stderr };
	}

	return {
		async dump(input) {
			const { target, password } = await targetFromRef(
				options.resolver,
				input.credentialRef,
			);
			return run(
				buildPgDumpArgv({
					target,
					filePath: input.filePath,
					format: input.format ?? "custom",
					...(input.schemaOnly !== undefined
						? { schemaOnly: input.schemaOnly }
						: undefined),
					...(input.noOwner !== undefined
						? { noOwner: input.noOwner }
						: undefined),
				}),
				libpqEnv(target, password),
				input.timeoutMs ?? defaultTimeoutMs,
			);
		},

		async restore(input) {
			const { target, password } = await targetFromRef(
				options.resolver,
				input.credentialRef,
			);
			return run(
				buildPgRestoreArgv({
					target,
					filePath: input.filePath,
					...(input.noOwner !== undefined
						? { noOwner: input.noOwner }
						: undefined),
					...(input.cleanFirst !== undefined
						? { cleanFirst: input.cleanFirst }
						: undefined),
				}),
				libpqEnv(target, password),
				input.timeoutMs ?? defaultTimeoutMs,
			);
		},

		async applySourceStatements(input) {
			const { target, password } = await targetFromRef(
				options.resolver,
				input.credentialRef,
			);
			for (const statement of input.statements) {
				assertArgvValue(statement.replace(/\n/gu, " "), "SQL statement");
			}
			return run(
				buildPsqlArgv(target),
				libpqEnv(target, password),
				input.timeoutMs ?? defaultTimeoutMs,
				`${input.statements.join("\n")}\n`,
			);
		},
	};
}
