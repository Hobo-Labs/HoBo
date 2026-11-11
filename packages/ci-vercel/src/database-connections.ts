import { randomUUID } from "node:crypto";

/** The pooled and direct connection strings of one PostgreSQL database, and
 * the variable names they were read from. Names only: a value never leaves. */
export type DatabaseUrls = {
	binding: "explicit" | "prisma-postgres" | "supabase";
	primary: string;
	primaryName: string;
	direct: string | undefined;
	directName: string;
};

/** Find the relay's database in the variables a Vercel storage integration
 * injects, so connecting a store needs no hand-copied connection string.
 *
 * `DATABASE_URL` + `DATABASE_URL_UNPOOLED` is the explicit pair (any
 * self-managed PostgreSQL). Prisma Postgres inverts the meaning of
 * `DATABASE_URL`: it is the direct string and `DATABASE_URL_POOLED` the pooled
 * one. Supabase supplies `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING`.
 * `HOBO_CI_DATABASE_ENV_PREFIX` selects a store connected under a prefix, which
 * is how two stores coexist while one replaces the other. */
export function resolveDatabaseUrls(env: NodeJS.ProcessEnv): DatabaseUrls {
	const prefix = env.HOBO_CI_DATABASE_ENV_PREFIX ?? "";
	if (prefix && !/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix))
		throw new Error("invalid HOBO_CI_DATABASE_ENV_PREFIX");
	const read = (name: string) => env[`${prefix}${name}`] || undefined;
	const named = (name: string) => `${prefix}${name}`;
	const explicit = read("DATABASE_URL");
	const unpooled = read("DATABASE_URL_UNPOOLED");
	if (explicit && unpooled)
		return {
			binding: "explicit",
			primary: explicit,
			primaryName: named("DATABASE_URL"),
			direct: unpooled,
			directName: named("DATABASE_URL_UNPOOLED"),
		};
	const prismaPooled = read("DATABASE_URL_POOLED");
	if (prismaPooled)
		return {
			binding: "prisma-postgres",
			primary: prismaPooled,
			primaryName: named("DATABASE_URL_POOLED"),
			direct: explicit,
			directName: named("DATABASE_URL"),
		};
	const supabase = read("POSTGRES_URL");
	if (supabase && !explicit)
		return {
			binding: "supabase",
			primary: supabase,
			primaryName: named("POSTGRES_URL"),
			direct: read("POSTGRES_URL_NON_POOLING"),
			directName: named("POSTGRES_URL_NON_POOLING"),
		};
	if (explicit)
		return {
			binding: "explicit",
			primary: explicit,
			primaryName: named("DATABASE_URL"),
			direct: undefined,
			directName: named("DATABASE_URL_UNPOOLED"),
		};
	throw new Error(`missing configuration: ${named("DATABASE_URL")}`);
}

/** Connection parameters that would replace a configured certificate
 * authority if left in the connection string. */
const TLS_PARAMETERS = [
	"ssl",
	"sslmode",
	"sslrootcert",
	"sslcert",
	"sslkey",
	"uselibpqcompat",
];

/** Pool settings for one connection string. Verification is never switched
 * off, with or without a configured certificate authority.
 *
 * A provider whose server certificate chains to its own root (Supabase, Amazon
 * RDS) needs that root: `HOBO_CI_DATABASE_CA_CERT` carries the PEM, the
 * string's own TLS parameters are dropped, and the certificate is verified
 * against it.
 *
 * Without one, a string that asks for TLS gets `verify-full`: the system trust
 * store and a hostname check. `sslmode=prefer`, `require` and `verify-ca` mean
 * less than that in libpq, and `pg` gives them the libpq meaning under
 * `uselibpqcompat=true` today and by default from its next major, where
 * `require` accepts any certificate. `sslmode=no-verify` and `ssl=no-verify`
 * say so outright. None of them reaches `pg`: the mode is rewritten to
 * `verify-full` and `uselibpqcompat` is dropped. `sslmode=disable` and a
 * string with no TLS parameter still mean a connection without TLS. */
export function databaseConnection(url: string, ca: string | undefined) {
	if (ca && !ca.includes("-----BEGIN CERTIFICATE-----"))
		throw new Error("HOBO_CI_DATABASE_CA_CERT is not a PEM certificate");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("invalid database URL");
	}
	const query = parsed.searchParams;
	if (ca) {
		for (const name of TLS_PARAMETERS) query.delete(name);
		return { connectionString: parsed.toString(), ssl: { ca } };
	}
	// `pg` takes the last of a repeated parameter, so every occurrence counts.
	const modes = query.getAll("sslmode");
	const unverified = query.getAll("ssl").includes("no-verify");
	const strict = modes.every((mode) => mode === "disable")
		? "disable"
		: "verify-full";
	if (
		!unverified &&
		!query.has("uselibpqcompat") &&
		(modes.length === 0 || (modes.length === 1 && modes[0] === strict))
	)
		return { connectionString: url };
	query.delete("uselibpqcompat");
	if (unverified) query.delete("ssl");
	if (unverified || modes.length > 0)
		query.set("sslmode", unverified ? "verify-full" : strict);
	return { connectionString: parsed.toString() };
}

/** One address pattern that identifies a transaction-mode pooler. Every field
 * that is set must match. */
export type TransactionPoolerRule = {
	host?: string;
	hostSuffix?: string;
	firstLabelSuffix?: string;
	port?: string;
};

/** The transaction-mode poolers that can be recognised by address, per
 * provider: Neon's `-pooler` endpoints, Prisma Postgres's
 * `pooled.db.prisma.io`, and Supabase's pooler host on its transaction port
 * 6543 (its port 5432 is session mode). Data, so a provider is added by adding
 * a row. Matched against every connection, whichever backend it belongs to. */
export const KNOWN_TRANSACTION_POOLERS = {
	neon: [{ hostSuffix: ".neon.tech", firstLabelSuffix: "-pooler" }],
	"prisma-postgres": [{ host: "pooled.db.prisma.io" }],
	// Port 6543 is transaction mode on the shared pooler host and on the
	// project host (the dedicated pooler); port 5432 is session or direct.
	supabase: [
		{ hostSuffix: ".pooler.supabase.com", port: "6543" },
		{ hostSuffix: ".supabase.co", port: "6543" },
	],
} satisfies { [provider: string]: TransactionPoolerRule[] };

/** A pooler that shares its host with the direct endpoint and differs only by
 * port. It cannot go in the table above, which is matched against every
 * connection: a port alone says nothing without knowing whose host it is. A
 * backend profile carries it, and it is applied to that backend only. */
export const PGBOUNCER_PORT_POOLER = [
	{ port: "6432" },
] satisfies TransactionPoolerRule[];

function matchesPooler(
	rule: TransactionPoolerRule,
	host: string,
	port: string,
): boolean {
	return (
		(rule.host === undefined || host === rule.host) &&
		(rule.hostSuffix === undefined || host.endsWith(rule.hostSuffix)) &&
		(rule.firstLabelSuffix === undefined ||
			host.split(".")[0]?.endsWith(rule.firstLabelSuffix) === true) &&
		(rule.port === undefined || port === rule.port)
	);
}

/** Session advisory locks must use a session-scoped PostgreSQL connection, not
 * a transaction-mode pooler. The known poolers are refused by address (see
 * `KNOWN_TRANSACTION_POOLERS`). Other endpoints are supplied by the operator
 * and cannot be identified reliably from a URL. */
export function validateDirectDatabaseUrl(
	value: string | undefined,
	name = "DATABASE_URL_UNPOOLED",
	backendPoolers: readonly TransactionPoolerRule[] = [],
): string {
	if (!value) throw new Error(`${name} is required for repair`);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("invalid unpooled database URL");
	}
	const host = parsed.hostname.toLowerCase();
	if (
		(parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
		!host ||
		host.includes("%") ||
		host.endsWith(".") ||
		!parsed.pathname ||
		parsed.searchParams.has("host") ||
		parsed.searchParams.has("hostaddr") ||
		parsed.searchParams.has("service") ||
		Object.values(KNOWN_TRANSACTION_POOLERS).some((rules) =>
			rules.some((rule) => matchesPooler(rule, host, parsed.port)),
		) ||
		backendPoolers.some((rule) => matchesPooler(rule, host, parsed.port))
	)
		throw new Error("repair requires a direct PostgreSQL URL");
	return value;
}

/** The two pools' settings for one relay database. A provider whose credential
 * is a short-lived token can supply these from a function instead of from
 * connection strings: `pg` accepts `password` as an async function. */
export type RelayDatabase = {
	/** Pooled settings, for HTTP traffic and ordinary queries. */
	primary: PoolSettings;
	/** Session-scoped settings, for repair. */
	direct: PoolSettings;
};
type PoolSettings = ReturnType<typeof databaseConnection> & {
	Client?: typeof import("pg").Client;
};

/** The relay database named by the environment, validated as before: the
 * session-scoped connection is required and must not be a known pooler. */
export function relayDatabase(
	env: NodeJS.ProcessEnv,
	backendPoolers: readonly TransactionPoolerRule[] = [],
): RelayDatabase {
	const urls = resolveDatabaseUrls(env);
	const ca = env.HOBO_CI_DATABASE_CA_CERT;
	const direct = validateDirectDatabaseUrl(
		urls.direct,
		urls.directName,
		backendPoolers,
	);
	return {
		primary: databaseConnection(urls.primary, ca),
		direct: databaseConnection(direct, ca),
	};
}

type Result = {
	rows: { database?: string; username?: string }[];
	rowCount: number | null;
};
type Client = {
	query(sql: string, values?: unknown[]): Promise<Result>;
	release(error?: Error | boolean): void;
};
type PrimaryPool = { connect(): Promise<Client> };
type DirectPool = { query(sql: string, values?: unknown[]): Promise<Result> };

/** Direct connections are scoped to one repair invocation, including failures. */
export async function withRepairPool<T extends { end(): Promise<void> }, R>(
	pool: T,
	run: (pool: T) => Promise<R>,
): Promise<R> {
	try {
		return await run(pool);
	} finally {
		await pool.end();
	}
}

/** The marker table `verifyRepairDatabase` uses, created on first use. */
// public-contract: the probe table's DDL, shared with the database fleet so both create the same table.
export const DATABASE_PROBE_TABLE = `CREATE TABLE IF NOT EXISTS hobo_ci_database_probes (
			id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
		)`;

/** Verify two endpoints reach the same database and role. A random committed
 * marker prevents separate servers with matching database names and roles from
 * passing. Old markers are bounded after an interrupted startup. */
export async function verifyRepairDatabase(
	primary: PrimaryPool,
	direct: DirectPool,
) {
	const marker = randomUUID();
	const client = await primary.connect();
	let inserted = false;
	let transactionOpen = false;
	let discard = false;
	let cleanupFailure: unknown;
	let cleanupFailed = false;
	try {
		await client.query("BEGIN");
		transactionOpen = true;
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-database-probe-v1'))",
		);
		await client.query(DATABASE_PROBE_TABLE);
		await client.query(
			"DELETE FROM hobo_ci_database_probes WHERE created_at < now() - interval '1 day'",
		);
		const identity = await client.query(
			"SELECT current_database() AS database, current_user AS username",
		);
		await client.query("INSERT INTO hobo_ci_database_probes (id) VALUES ($1)", [
			marker,
		]);
		await client.query("COMMIT");
		transactionOpen = false;
		inserted = true;
		const found = await direct.query(
			"SELECT current_database() AS database, current_user AS username FROM hobo_ci_database_probes WHERE id = $1",
			[marker],
		);
		if (
			found.rowCount !== 1 ||
			!identity.rows[0] ||
			found.rows[0]?.database !== identity.rows[0].database ||
			found.rows[0]?.username !== identity.rows[0].username
		)
			throw new Error(
				"repair database does not match the primary database and role",
			);
	} catch (error) {
		if (transactionOpen) {
			try {
				await client.query("ROLLBACK");
				transactionOpen = false;
			} catch {
				discard = true;
			}
		} else if (!inserted) {
			// A failed BEGIN can leave the transaction state unknown.
			discard = true;
		}
		throw error;
	} finally {
		try {
			if (inserted)
				await client.query(
					"DELETE FROM hobo_ci_database_probes WHERE id = $1",
					[marker],
				);
		} catch (error) {
			discard = true;
			cleanupFailed = true;
			cleanupFailure = error;
		} finally {
			client.release(discard);
		}
	}
	if (cleanupFailed) throw cleanupFailure;
}
