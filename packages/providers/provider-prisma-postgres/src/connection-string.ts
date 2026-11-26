/**
 * Splitting a PostgreSQL URI into the part that is an address and the part
 * that is a credential. Failures never quote the input, because the input is
 * the credential.
 */
import { containsControlChar, PrismaProviderError } from "./errors.js";

export type PostgresConnectionParts = {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly username: string;
	readonly tls: boolean;
	readonly parameters: Readonly<Record<string, string>>;
	readonly hasPassword: boolean;
};

const DEFAULT_POSTGRES_PORT = 5432;
const HOSTNAME =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;

export function parsePostgresConnectionUri(
	value: string,
): PostgresConnectionParts {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the CLI returned a connection string that is not a URI",
		);
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the CLI returned a connection string that is not a postgres URI",
		);
	}
	const host = url.hostname.toLowerCase();
	if (!HOSTNAME.test(host)) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the CLI connection string does not carry a plain hostname",
		);
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
	if (
		database === "" ||
		database.length > 128 ||
		containsControlChar(database)
	) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the CLI connection string does not name a usable database",
		);
	}
	const username = decodeURIComponent(url.username);
	if (username === "" || username.length > 128) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the CLI connection string does not carry a role name",
		);
	}
	const parameters: Record<string, string> = {};
	for (const [key, parameterValue] of url.searchParams.entries()) {
		if (!/^[a-z_][a-z0-9_]{0,63}$/u.test(key)) continue;
		// `password`, `passfile`, and Prisma's `api_key` are credential-bearing
		// query parameters, so they are dropped rather than republished.
		if (key === "password" || key === "passfile" || key === "api_key") continue;
		parameters[key] = parameterValue.slice(0, 128);
	}
	const sslmode = parameters.sslmode;
	const tls =
		sslmode === undefined ? true : sslmode !== "disable" && sslmode !== "allow";

	return {
		host,
		port: url.port === "" ? DEFAULT_POSTGRES_PORT : Number(url.port),
		database,
		username,
		tls,
		parameters: Object.freeze(parameters),
		hasPassword: url.password !== "",
	};
}
