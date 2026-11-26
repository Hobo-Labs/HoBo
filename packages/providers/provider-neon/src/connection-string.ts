/**
 * Splitting a PostgreSQL URI into the part that is an address and the part
 * that is a credential.
 *
 * Everything in {@link PostgresConnectionParts} except `username` is safe to
 * publish; `username` is kept off receipts because it is half of a
 * user/password pair and gives an attacker a free guess.
 */
import { containsControlChar, NeonProviderError } from "./errors.js";

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

/**
 * Parse a `postgres(ql)://` URI. Failures never quote the input: the input is
 * the credential.
 */
export function parsePostgresConnectionUri(
	value: string,
): PostgresConnectionParts {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider returned a connection string that is not a URI",
		);
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider returned a connection string that is not a postgres URI",
		);
	}
	const host = url.hostname.toLowerCase();
	if (!HOSTNAME.test(host)) {
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider connection string does not carry a plain hostname",
		);
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
	if (
		database === "" ||
		database.length > 128 ||
		containsControlChar(database)
	) {
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider connection string does not name a usable database",
		);
	}
	const username = decodeURIComponent(url.username);
	if (username === "" || username.length > 128) {
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider connection string does not carry a role name",
		);
	}
	const parameters: Record<string, string> = {};
	for (const [key, parameterValue] of url.searchParams.entries()) {
		if (!/^[a-z_][a-z0-9_]{0,63}$/u.test(key)) continue;
		// A connection parameter is not a credential today, but `password=` is
		// a legal libpq keyword, so it is dropped rather than republished.
		if (key === "password" || key === "passfile") continue;
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

/**
 * Neon's documented rule for turning the pooled endpoint into the direct one:
 * drop `-pooler` from the first hostname label. Applied to the host only, so a
 * literal `-pooler` elsewhere in the credential is untouched.
 */
export function toDirectHost(host: string): string {
	const [first, ...rest] = host.split(".");
	if (first === undefined) return host;
	return [first.replace(/-pooler$/u, ""), ...rest].join(".");
}

export function isPooledHost(host: string): boolean {
	const [first] = host.split(".");
	return first?.endsWith("-pooler") ?? false;
}

/**
 * Derive the direct-connection URI from the pooled one. The result is secret
 * material and is deposited by the caller before anything else happens to it.
 */
export function deriveDirectConnectionUri(pooled: string): string | undefined {
	let url: URL;
	try {
		url = new URL(pooled);
	} catch {
		return undefined;
	}
	const direct = toDirectHost(url.hostname.toLowerCase());
	if (direct === url.hostname.toLowerCase()) return undefined;
	url.hostname = direct;
	return url.toString();
}
