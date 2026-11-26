/**
 * `migration.postgres.pg-dump/v1`.
 *
 * Same non-negotiables as everywhere else in this package: argv arrays through
 * the injected {@link ProcessRunner}, no shell, credentials in the libpq
 * environment rather than on the command line. `--dbname=<uri>` would be
 * shorter and would publish the password to every `ps` on the host.
 *
 * `migration.postgres.logical-copy/v1` is deliberately **not** offered: Prisma
 * does not document logical-replication access on a claimable database, and
 * advertising a migration path that fails at execution time is worse than
 * advertising one fewer.
 */
import type { SecretRef } from "@hobo/bindings";

import type { ProcessRunner } from "./cli.js";
import { parsePostgresConnectionUri } from "./connection-string.js";
import { resolveSecret, type SecretResolverPort } from "./custody.js";
import {
	containsControlChar,
	PrismaProviderError,
	redactProviderText,
} from "./errors.js";

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

function assertArgvValue(value: string, what: string): string {
	if (value.length === 0 || value.length > 1024) {
		throw new PrismaProviderError(
			"MIGRATION_FAILED",
			`${what} must be 1-1024 characters`,
		);
	}
	if (containsControlChar(value)) {
		throw new PrismaProviderError(
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
	/prisma\+postgres:\/\//i,
	/(?:^|[=\s])(?:--)?password[=\s]/i,
	/\bapi_key=/i,
	/\/\/[^/\s:@]+:[^/\s:@]+@/u,
];

export function assertArgvSafe(argv: readonly string[]): readonly string[] {
	if (argv.length === 0) {
		throw new PrismaProviderError(
			"MIGRATION_FAILED",
			"refusing to run an empty argv",
		);
	}
	for (const element of argv) {
		assertArgvValue(element, "argv element");
		for (const pattern of ARGV_CREDENTIAL_PATTERNS) {
			if (pattern.test(element)) {
				throw new PrismaProviderError(
					"MIGRATION_FAILED",
					"refusing to place credential-shaped material in argv; pass it through the environment or stdin",
				);
			}
		}
	}
	return argv;
}

function targetArgv(target: PostgresTarget): readonly string[] {
	// Fused `--flag=value` form: a value beginning with `-` can never be
	// re-read by the child as a flag of its own.
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
		throw new PrismaProviderError(
			"MIGRATION_FAILED",
			"pg_dump cannot be both schema-only and data-only",
		);
	}
	return assertArgvSafe([
		assertArgvValue(spec.binary ?? "pg_dump", "pg_dump binary"),
		...targetArgv(spec.target),
		`--format=${spec.format}`,
		`--file=${assertArgvValue(spec.filePath, "dump file path")}`,
		...(spec.schemaOnly === true ? ["--schema-only"] : []),
		...(spec.dataOnly === true ? ["--data-only"] : []),
		...(spec.noOwner === true ? ["--no-owner", "--no-acl"] : []),
	]);
}

export function buildPgRestoreArgv(spec: PgRestoreSpec): readonly string[] {
	return assertArgvSafe([
		assertArgvValue(spec.binary ?? "pg_restore", "pg_restore binary"),
		...targetArgv(spec.target),
		...(spec.noOwner === true ? ["--no-owner", "--no-acl"] : []),
		...(spec.cleanFirst === true ? ["--clean", "--if-exists"] : []),
		assertArgvValue(spec.filePath, "dump file path"),
	]);
}

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
	readonly stderr: string;
};

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
		throw new PrismaProviderError(
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
	): Promise<MigrationOutcome> {
		const result = await options.runner.run(assertArgvSafe(argv), {
			env,
			timeoutMs,
		});
		const stderr = redactProviderText(result.stderr, 512);
		if (result.code !== 0) {
			throw new PrismaProviderError(
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
	};
}
