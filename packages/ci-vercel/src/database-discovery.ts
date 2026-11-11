import { createHash } from "node:crypto";
import {
	type DatabaseUrls,
	resolveDatabaseUrls,
} from "./database-connections.js";

/** One PostgreSQL database found in the environment. Names and a digest only:
 * no connection string, host or credential is ever part of this record. */
export type DiscoveredDatabase = {
	/** The prefix its variables were injected under; empty for none. */
	prefix: string;
	binding: DatabaseUrls["binding"];
	primaryName: string;
	directName: string;
	/** Whether a session-scoped connection string is present for repair. */
	hasDirect: boolean;
	/** A short digest of host, port and database name. Two entries with the
	 * same digest are the same database under two sets of variable names. */
	database: string;
};

/** The variable names a Vercel storage integration injects, as suffixes. A
 * store connected under a prefix carries the same names behind that prefix. */
const SUFFIXES = [
	"DATABASE_URL_UNPOOLED",
	"DATABASE_URL_POOLED",
	"DATABASE_URL",
	"POSTGRES_URL_NON_POOLING",
	"POSTGRES_URL",
];

function prefixesOf(env: NodeJS.ProcessEnv): string[] {
	const prefixes = new Set<string>();
	for (const key of Object.keys(env)) {
		const suffix = SUFFIXES.find((candidate) => key.endsWith(candidate));
		if (!suffix) continue;
		const prefix = key.slice(0, key.length - suffix.length);
		if (prefix === "" || /^[A-Za-z][A-Za-z0-9_]*$/.test(prefix))
			prefixes.add(prefix);
	}
	return [...prefixes].sort();
}

function digestOf(connection: string): string | undefined {
	try {
		const url = new URL(connection);
		if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
			return undefined;
		return createHash("sha256")
			.update(`${url.hostname}\n${url.port || "5432"}\n${url.pathname}`)
			.digest("hex")
			.slice(0, 12);
	} catch {
		return undefined;
	}
}

/** Every distinct PostgreSQL database the environment names, in a stable
 * order: the unprefixed one first, then by prefix. An integration that
 * injects one database under several names (Neon sets both `DATABASE_URL` and
 * `POSTGRES_URL`) appears once. A prefix whose variables do not resolve to a
 * database is skipped. */
export function discoverDatabases(
	env: NodeJS.ProcessEnv,
): DiscoveredDatabase[] {
	const found: DiscoveredDatabase[] = [];
	for (const prefix of prefixesOf(env)) {
		let urls: DatabaseUrls;
		try {
			urls = resolveDatabaseUrls({
				...env,
				HOBO_CI_DATABASE_ENV_PREFIX: prefix,
			});
		} catch {
			continue;
		}
		const database = digestOf(urls.primary);
		if (!database || found.some((entry) => entry.database === database))
			continue;
		found.push({
			prefix,
			binding: urls.binding,
			primaryName: urls.primaryName,
			directName: urls.directName,
			hasDirect: !!urls.direct,
			database,
		});
	}
	return found;
}
