/**
 * `migration.postgres.pg-dump/v1` and `migration.postgres.logical-copy/v1`.
 *
 * Everything here is a pure function over data. Three rules hold it together
 * and none of them is negotiable:
 *
 * 1. **Argv arrays, never shell strings.** A command is `readonly string[]`
 *    handed to `execve`-style spawning with no shell, so a database named
 *    `x; DROP DATABASE prod` is one inert argument rather than two commands.
 *    There is no code path in this module that produces a joined string.
 * 2. **Every interpolated field is parsed.** Hosts, roles, database names, and
 *    file paths cross a parser that rejects shell metacharacters, control
 *    characters, and traversal. This is belt-and-braces on top of rule 1: argv
 *    is already safe against the shell, but a `--dbname=--something` or a path
 *    that escapes the artifact directory is a different bug.
 * 3. **Credentials never reach argv.** libpq is told the password through
 *    `PGPASSWORD` or a `PGPASSFILE` locator. `--dbname=<uri>` is the convenient
 *    call and it is the one that puts the password in `ps` output for every
 *    user on the machine.
 */
import { PostgresDataError } from "./errors.js";

export const POSTGRES_MIGRATION_PROFILES = [
	"migration.postgres.pg-dump/v1",
	"migration.postgres.logical-copy/v1",
] as const;

export type PostgresMigrationProfileId =
	(typeof POSTGRES_MIGRATION_PROFILES)[number];

// public-contract: stable pg_dump migration profile identifier.
export const PG_DUMP_PROFILE = "migration.postgres.pg-dump/v1" as const;
// public-contract: stable logical-copy migration profile identifier.
export const LOGICAL_COPY_PROFILE =
	"migration.postgres.logical-copy/v1" as const;

export const PG_DUMP_FORMATS = ["custom", "directory", "tar", "plain"] as const;

export type PgDumpFormat = (typeof PG_DUMP_FORMATS)[number];

export const POSTGRES_SSL_MODES = [
	"require",
	"verify-ca",
	"verify-full",
	"prefer",
] as const;

export type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

declare const targetBrand: unique symbol;

/** A connection target whose every field has crossed the parser. */
// parallel-type-allowed: branded parse-don't-validate refinement, constructible only through parsePostgresTarget; the proto PostgresTarget is its unbranded wire projection.
export type PostgresTarget = {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly username: string;
	readonly sslMode: PostgresSslMode;
	readonly [targetBrand]: "PostgresTarget";
};

export type PostgresTargetInput = {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly username: string;
	readonly sslMode: PostgresSslMode;
};

function unsafe(
	message: string,
	detail?: Record<string, string | number>,
): never {
	throw new PostgresDataError(
		"UNSAFE_COMMAND_ARGUMENT",
		message,
		detail === undefined ? {} : { detail },
	);
}

/**
 * Characters that have no business in a hostname, a role name, a database
 * name, or a path, and that turn one into a command if the value ever reaches
 * a shell, a `CREATE SUBSCRIPTION` string, or a log line.
 */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function hasNulOrNewline(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 0x00 || code === 0x0a || code === 0x0d) return true;
	}
	return false;
}

const SHELL_METACHARACTERS = /[;&|`$(){}<>*?!#~\\'"]/u;
const WHITESPACE = /\s/u;

const HOSTNAME =
	/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
/** Unquoted SQL/libpq identifier plus the punctuation real database names use. */
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/u;

/**
 * Reject anything that could be re-read as a flag by the child process.
 *
 * Every value this module interpolates is emitted in fused `--flag=value` form
 * for exactly this reason, but a leading `-` in a positional argument (a dump
 * file path, for instance) is still a live hazard.
 */
function assertNotFlagLike(value: string, what: string): void {
	if (value.startsWith("-")) {
		unsafe(`${what} must not begin with "-"; it would be read as a flag`);
	}
}

function assertNoInjection(value: string, what: string): string {
	if (value.length === 0) unsafe(`${what} must not be empty`);
	if (value.length > 255) unsafe(`${what} exceeds 255 characters`);
	if (hasControlCharacter(value) || SHELL_METACHARACTERS.test(value)) {
		unsafe(
			`${what} contains a shell metacharacter or control character and will not be placed in a command`,
		);
	}
	if (WHITESPACE.test(value)) unsafe(`${what} must not contain whitespace`);
	return value;
}

export function parsePostgresHost(host: string): string {
	const lowered = assertNoInjection(host, "host").toLowerCase();
	if (!HOSTNAME.test(lowered) && !IPV4.test(lowered)) {
		unsafe("host must be a DNS hostname or an IPv4 literal");
	}
	return lowered;
}

export function parsePostgresPort(port: number): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		unsafe("port must be an integer between 1 and 65535");
	}
	return port;
}

export function parsePostgresIdentifier(value: string, what: string): string {
	assertNoInjection(value, what);
	assertNotFlagLike(value, what);
	if (!IDENTIFIER.test(value)) {
		unsafe(`${what} must be a plain identifier`, { what });
	}
	return value;
}

export function parsePostgresTarget(
	input: PostgresTargetInput,
): PostgresTarget {
	// SAFETY: the closed ssl-mode list is the runtime validator for this input.
	if (!(POSTGRES_SSL_MODES as readonly string[]).includes(input.sslMode)) {
		unsafe(
			`sslMode ${JSON.stringify(String(input.sslMode))} is not a libpq ssl mode`,
		);
	}
	// SAFETY: every field is parsed above; the remaining brand records that invariant.
	return {
		host: parsePostgresHost(input.host),
		port: parsePostgresPort(input.port),
		database: parsePostgresIdentifier(input.database, "database name"),
		username: parsePostgresIdentifier(input.username, "role name"),
		sslMode: input.sslMode,
	} as PostgresTarget;
}

/**
 * Parse an artifact path.
 *
 * Traversal is rejected outright rather than resolved: this package is pure and
 * has no filesystem, so it cannot know what `..` would resolve to. A caller
 * that genuinely needs a parent directory passes the resolved absolute path.
 */
export function parseArtifactPath(
	value: string,
	what = "artifact path",
): string {
	if (value.length === 0) unsafe(`${what} must not be empty`);
	if (value.length > 1024) unsafe(`${what} exceeds 1024 characters`);
	if (hasControlCharacter(value)) {
		unsafe(`${what} contains a control character`);
	}
	if (/[;&|`$(){}<>*?!"']/u.test(value)) {
		unsafe(`${what} contains a shell metacharacter`);
	}
	assertNotFlagLike(value, what);
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment === "..") {
			unsafe(`${what} contains a parent-directory traversal segment`);
		}
	}
	return value;
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/postgres(?:ql)?:\/\//iu,
	/\/\/[^/\s:@]+:[^/\s:@]+@/u,
	/(?:^|[=\s])(?:--)?(?:password|pgpassword|pwd)[=\s]/iu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

/**
 * The last thing that happens before a command is handed to a runner.
 *
 * Every builder in this module already produces safe argv; this is here so a
 * caller that assembles its own argv cannot skip the check, and so a future
 * edit that reintroduces a URI argument fails a test rather than a pentest.
 */
export function assertArgvSafe(argv: readonly string[]): readonly string[] {
	if (argv.length === 0) {
		unsafe("refusing to run an empty argv");
	}
	for (const element of argv) {
		if (element.length > 1024) unsafe("argv element exceeds 1024 characters");
		if (hasNulOrNewline(element)) {
			unsafe("argv element contains a NUL or newline");
		}
		for (const pattern of CREDENTIAL_PATTERNS) {
			if (pattern.test(element)) {
				unsafe(
					"refusing to place credential-shaped material in argv; pass it through the environment or a passfile",
				);
			}
		}
	}
	return argv;
}

function targetArgv(target: PostgresTarget): readonly string[] {
	// Fused `--flag=value` throughout: a value starting with `-` can never be
	// re-read by the child as a flag of its own.
	return [
		`--host=${target.host}`,
		`--port=${String(target.port)}`,
		`--username=${target.username}`,
		`--dbname=${target.database}`,
		"--no-password",
	];
}

export type PgDumpSpec = {
	readonly target: PostgresTargetInput;
	/** Where pg_dump writes. Parsed, never resolved. */
	readonly filePath: string;
	readonly format: PgDumpFormat;
	readonly schemaOnly?: boolean;
	readonly dataOnly?: boolean;
	readonly noOwner?: boolean;
	/** Override the binary name/path. Defaults to `pg_dump` on PATH. */
	readonly binary?: string;
};

export function buildPgDumpArgv(spec: PgDumpSpec): readonly string[] {
	if (spec.schemaOnly === true && spec.dataOnly === true) {
		throw new PostgresDataError(
			"MIGRATION_FAILED",
			"pg_dump cannot be both schema-only and data-only",
		);
	}
	// SAFETY: the closed format list is the runtime validator for this input.
	if (!(PG_DUMP_FORMATS as readonly string[]).includes(spec.format)) {
		unsafe(
			`pg_dump format ${JSON.stringify(String(spec.format))} is not supported`,
		);
	}
	const target = parsePostgresTarget(spec.target);
	const argv = [
		parseArtifactPath(spec.binary ?? "pg_dump", "pg_dump binary"),
		...targetArgv(target),
		`--format=${spec.format}`,
		`--file=${parseArtifactPath(spec.filePath, "dump file path")}`,
		...(spec.schemaOnly === true ? ["--schema-only"] : []),
		...(spec.dataOnly === true ? ["--data-only"] : []),
		...(spec.noOwner === true ? ["--no-owner", "--no-acl"] : []),
	];
	return assertArgvSafe(argv);
}

export type PgRestoreSpec = {
	readonly target: PostgresTargetInput;
	readonly filePath: string;
	readonly noOwner?: boolean;
	readonly cleanFirst?: boolean;
	readonly singleTransaction?: boolean;
	readonly binary?: string;
};

export function buildPgRestoreArgv(spec: PgRestoreSpec): readonly string[] {
	const target = parsePostgresTarget(spec.target);
	const argv = [
		parseArtifactPath(spec.binary ?? "pg_restore", "pg_restore binary"),
		...targetArgv(target),
		...(spec.noOwner === true ? ["--no-owner", "--no-acl"] : []),
		...(spec.cleanFirst === true ? ["--clean", "--if-exists"] : []),
		...(spec.singleTransaction === true ? ["--single-transaction"] : []),
		parseArtifactPath(spec.filePath, "dump file path"),
	];
	return assertArgvSafe(argv);
}

/** `psql` reading SQL from stdin, with errors fatal. */
export function buildPsqlArgv(
	targetInput: PostgresTargetInput,
	binary = "psql",
): readonly string[] {
	const target = parsePostgresTarget(targetInput);
	return assertArgvSafe([
		parseArtifactPath(binary, "psql binary"),
		...targetArgv(target),
		"--no-psqlrc",
		"--quiet",
		"--set=ON_ERROR_STOP=1",
		"--file=-",
	]);
}

/**
 * How the password reaches the child. Both variants keep it out of argv; the
 * passfile variant additionally keeps it out of the environment, which matters
 * on a host where `/proc/<pid>/environ` is readable.
 */
export type LibpqCredentialChannel =
	| { readonly kind: "environment"; readonly password: string }
	| { readonly kind: "passfile"; readonly path: string };

/**
 * The libpq environment for a run.
 *
 * Returned frozen and complete: a runner must pass exactly this and must not
 * merge the ambient environment, or an inherited `PGSSLMODE=disable` silently
 * downgrades the connection.
 */
export function buildLibpqEnvironment(
	targetInput: PostgresTargetInput,
	credential: LibpqCredentialChannel,
	options: { readonly connectTimeoutSeconds?: number } = {},
): Readonly<Record<string, string>> {
	const target = parsePostgresTarget(targetInput);
	const connectTimeout = options.connectTimeoutSeconds ?? 15;
	if (
		!Number.isInteger(connectTimeout) ||
		connectTimeout < 1 ||
		connectTimeout > 600
	) {
		unsafe(
			"connect timeout must be an integer number of seconds between 1 and 600",
		);
	}
	type LibpqEnvironment = Record<string, string>;
	const base: LibpqEnvironment = {
		PGHOST: target.host,
		PGPORT: String(target.port),
		PGUSER: target.username,
		PGDATABASE: target.database,
		PGSSLMODE: target.sslMode,
		PGCONNECT_TIMEOUT: String(connectTimeout),
	};
	if (credential.kind === "environment") {
		if (credential.password.length === 0) {
			unsafe("an environment credential must carry a password");
		}
		base.PGPASSWORD = credential.password;
	} else {
		base.PGPASSFILE = parseArtifactPath(credential.path, "passfile path");
	}
	return Object.freeze(base);
}

export type LogicalCopyPlan = {
	readonly profile: typeof LOGICAL_COPY_PROFILE;
	readonly publicationName: string;
	readonly subscriptionName: string;
	readonly sourceStatements: readonly string[];
	/**
	 * Always true. The destination needs
	 * `CREATE SUBSCRIPTION ... CONNECTION '<dsn>'`, which embeds a credential in
	 * SQL text, so that statement is never assembled here: the caller composes
	 * it inside the resolved-secret scope and sends it on stdin.
	 */
	readonly destinationStatementsRequireDsn: true;
};

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export function buildLogicalCopyPlan(input: {
	readonly publicationName: string;
	readonly subscriptionName: string;
	readonly tables?: readonly string[];
	/** Products must opt in at creation time; this cannot be turned on later. */
	readonly logicalReplicationEnabled: boolean;
}): LogicalCopyPlan {
	if (!input.logicalReplicationEnabled) {
		throw new PostgresDataError(
			"MIGRATION_FAILED",
			"a logical copy needs a source with logical replication enabled; most claimable products decide this at creation time and cannot enable it afterwards",
		);
	}
	for (const name of [input.publicationName, input.subscriptionName]) {
		if (!SQL_IDENTIFIER.test(name)) {
			unsafe(
				"publication and subscription names must be plain lowercase SQL identifiers",
			);
		}
	}
	for (const table of input.tables ?? []) {
		if (!SQL_IDENTIFIER.test(table)) {
			unsafe(
				"table names for a logical copy must be plain lowercase SQL identifiers",
			);
		}
	}
	const scope =
		input.tables === undefined || input.tables.length === 0
			? "FOR ALL TABLES"
			: `FOR TABLE ${[...input.tables].sort((a, b) => a.localeCompare(b)).join(", ")}`;
	return {
		profile: LOGICAL_COPY_PROFILE,
		publicationName: input.publicationName,
		subscriptionName: input.subscriptionName,
		sourceStatements: [`CREATE PUBLICATION ${input.publicationName} ${scope};`],
		destinationStatementsRequireDsn: true,
	};
}
