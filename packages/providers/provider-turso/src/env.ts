/**
 * Binding the libSQL ephemeral state to Turso from the environment.
 *
 * The Turso integration in the Vercel Marketplace injects `TURSO_DATABASE_URL`
 * and `TURSO_AUTH_TOKEN` into the project. A Marketplace integration can be
 * connected with a custom environment-variable prefix; pass the same string as
 * `prefix` and it is prepended verbatim to both names (the exact form a prefix
 * takes on a given project is not verified here — read the names off the
 * project before relying on one).
 *
 * Only names are logged or returned. Values go straight to the client and are
 * never echoed, not even in an error message.
 *
 * The client is `@libsql/client/http`: plain `fetch`, no WebSocket and no
 * native module, so it bundles into a Vercel Function (Node or Edge runtime)
 * without the `libsql` binary the package's Node entry point loads for
 * `file:` URLs. A `libsql://` URL is sent over HTTPS by that client
 * (`expandConfig(config, preferHttp = true)` in `@libsql/core`; documented for
 * `@libsql/client/web` in the client's API reference,
 * https://github.com/tursodatabase/libsql-client-ts/blob/main/_autodocs/api-reference/client-web.md).
 */
import type { EphemeralStatePort } from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";
import { type Config, createClient } from "@libsql/client/http";

import {
	createLibsqlEphemeralState,
	type LibsqlEphemeralStateOptions,
} from "./ephemeral-state.js";
import type { LibsqlStatementClient } from "./meter.js";

// public-contract: env names the Turso Marketplace integration injects and the relay reads.
export const TURSO_ENV_NAMES = Object.freeze({
	url: "TURSO_DATABASE_URL",
	token: "TURSO_AUTH_TOKEN",
} as const);

const ENV_PREFIX = /^[A-Z][A-Z0-9_]{0,63}$/u;

type Env = Readonly<Record<string, string | undefined>>;

// domain-view: the generated TursoEnvSource narrowed to the two names this helper reads.
export type TursoEnvNames = {
	readonly url: string;
	readonly token: string;
};

export type TursoEnv = {
	/** The variable names that supplied the binding — safe to log. */
	readonly source: TursoEnvNames;
	readonly url: string;
	readonly authToken: string;
};

const unavailable = (message: string) =>
	new KvRedisCompatibleError("EPHEMERAL_BINDING_UNAVAILABLE", message);

function namesFor(prefix: string | undefined): TursoEnvNames {
	if (prefix === undefined || prefix === "") return TURSO_ENV_NAMES;
	if (!ENV_PREFIX.test(prefix)) {
		throw unavailable(
			"a Turso environment prefix must be upper-case letters, digits and underscores",
		);
	}
	return {
		url: `${prefix}${TURSO_ENV_NAMES.url}`,
		token: `${prefix}${TURSO_ENV_NAMES.token}`,
	};
}

/** Schemes the HTTP client accepts. `http:` only for a local `sqld`. */
function remoteUrl(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.username !== "" || url.password !== "") return false;
	if (url.protocol === "libsql:" || url.protocol === "https:") return true;
	return (
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1")
	);
}

/**
 * The Turso pair in `env`, or `undefined` when neither variable is set. Half a
 * pair, or a URL that is not a remote libSQL URL, is an error naming the
 * variable and never quoting its value.
 */
export function resolveTursoEnv(
	env: Env,
	options: { readonly prefix?: string } = {},
): TursoEnv | undefined {
	const names = namesFor(options.prefix);
	const url = env[names.url];
	const authToken = env[names.token];
	if (!url && !authToken) return undefined;
	if (!url || !authToken) {
		throw unavailable(
			`${url ? names.token : names.url} is not set although ${url ? names.url : names.token} is`,
		);
	}
	if (!remoteUrl(url)) {
		throw unavailable(
			`${names.url} is not a libsql: or https: URL without embedded credentials`,
		);
	}
	return { source: names, url, authToken };
}

export type TursoEphemeralStateOptions = Omit<
	LibsqlEphemeralStateOptions,
	"client"
> & {
	readonly env: Env;
	readonly prefix?: string;
	/** The host's `fetch`. Default: the global one, as `@libsql/client/http` does. */
	readonly fetch?: typeof globalThis.fetch;
	/** Wrap the client, e.g. with `meterLibsqlClient`. */
	readonly wrap?: (client: LibsqlStatementClient) => LibsqlStatementClient;
};

export type TursoEphemeralState = {
	readonly port: EphemeralStatePort;
	readonly source: TursoEnvNames;
	/** Close the HTTP client when the host shuts down. */
	close(): void;
};

/** `undefined` when the environment names no Turso database. Opens no connection. */
export function createTursoEphemeralState(
	options: TursoEphemeralStateOptions,
): TursoEphemeralState | undefined {
	const resolved = resolveTursoEnv(
		options.env,
		options.prefix === undefined ? {} : { prefix: options.prefix },
	);
	if (resolved === undefined) return undefined;
	const config: Config = { url: resolved.url, authToken: resolved.authToken };
	if (options.fetch !== undefined) config.fetch = options.fetch;
	const client = createClient(config);
	const { env: _env, prefix: _prefix, fetch: _fetch, wrap, ...rest } = options;
	return {
		port: createLibsqlEphemeralState({
			...rest,
			client: wrap ? wrap(client) : client,
		}),
		source: resolved.source,
		close: () => client.close(),
	};
}
