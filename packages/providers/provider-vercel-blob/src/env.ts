/**
 * Binding the Blob port from a Vercel deployment's environment.
 *
 * Connecting a Blob store to a project adds `BLOB_STORE_ID` (an identifier,
 * not a secret) and makes Vercel issue a short-lived OIDC token the SDK reads
 * and refreshes itself (https://vercel.com/docs/vercel-blob#oidc-access-by-default).
 * The binding passes the store id explicitly and never reads, passes or logs
 * the token; the docs warn that a token passed explicitly bypasses the SDK's
 * refresh (https://vercel.com/docs/vercel-blob/using-blob-sdk).
 *
 * The SDK's credential order is: an explicit `token`, then the OIDC token
 * with a store id, then `BLOB_READ_WRITE_TOKEN`. In a Vercel Function the
 * OIDC token arrives with each request rather than in the environment, so
 * `oidcTokenInEnv` is false there and the SDK still finds it; outside Vercel
 * (CI, local) it is in the environment after `vercel env pull`. When a static
 * `BLOB_READ_WRITE_TOKEN` is also present the SDK falls back to it whenever no
 * OIDC token is found; `readWriteTokenPresent` reports that so a host can
 * refuse it under the secretless-first rule (ADR-0027).
 *
 * The store itself is created and connected to the relay's project by its
 * owner (dashboard or `vercel blob create-store --access private`) or by the
 * CI deploy step. An agent's MCP identity cannot do it and should not try.
 */
import type { EphemeralStatePort } from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";

import {
	createVercelBlobEphemeralState,
	type VercelBlobEphemeralStateOptions,
} from "./ephemeral-state.js";
import { vercelBlobSdk } from "./sdk.js";

// public-contract: env names a connected Blob store and Vercel OIDC provide.
export const VERCEL_BLOB_ENV_NAMES = Object.freeze({
	storeId: "BLOB_STORE_ID",
	oidcToken: "VERCEL_OIDC_TOKEN",
	readWriteToken: "BLOB_READ_WRITE_TOKEN",
} as const);

const STORE_ID = /^(?:store_)?[A-Za-z0-9]{1,64}$/u;

type Env = Readonly<Record<string, string | undefined>>;

// domain-view: the generated VercelBlobEnvSource as read from an environment.
export type VercelBlobEnvOrigin = {
	readonly storeIdVariable: string;
	readonly oidcTokenInEnv: boolean;
	readonly readWriteTokenPresent: boolean;
};

export type VercelBlobEnv = {
	/** Names and presence only — safe to log. */
	readonly source: VercelBlobEnvOrigin;
	/** The connected store's id (`store_<id>` or `<id>`); an identifier, not a secret. */
	readonly storeId: string;
};

const present = (value: string | undefined) =>
	value !== undefined && value.trim() !== "";

/**
 * The connected store, or `undefined` when no `BLOB_STORE_ID` is set.
 * `prefix` is prepended verbatim to the store-id name, for a store connected
 * with a custom environment-variable prefix.
 */
export function resolveVercelBlobEnv(
	env: Env,
	options: { readonly prefix?: string } = {},
): VercelBlobEnv | undefined {
	const storeIdVariable = `${options.prefix ?? ""}${VERCEL_BLOB_ENV_NAMES.storeId}`;
	const raw = env[storeIdVariable];
	if (!present(raw)) return undefined;
	const storeId = raw?.trim() ?? "";
	if (!STORE_ID.test(storeId)) {
		throw new KvRedisCompatibleError(
			"EPHEMERAL_BINDING_UNAVAILABLE",
			`${storeIdVariable} is not a Blob store id (store_<id> or <id>)`,
		);
	}
	return {
		source: {
			storeIdVariable,
			oidcTokenInEnv: present(env[VERCEL_BLOB_ENV_NAMES.oidcToken]),
			readWriteTokenPresent: present(env[VERCEL_BLOB_ENV_NAMES.readWriteToken]),
		},
		storeId,
	};
}

export type VercelBlobEphemeralStateFromEnv = {
	readonly source: VercelBlobEnvOrigin;
	readonly port: EphemeralStatePort;
};

export function createVercelBlobEphemeralStateFromEnv(
	options: Omit<VercelBlobEphemeralStateOptions, "sdk" | "storeId"> & {
		readonly env: Env;
		readonly prefix?: string;
		/** Default the real SDK. */
		readonly sdk?: VercelBlobEphemeralStateOptions["sdk"];
	},
): VercelBlobEphemeralStateFromEnv | undefined {
	const { env, prefix, sdk, ...rest } = options;
	const resolved = resolveVercelBlobEnv(
		env,
		prefix === undefined ? {} : { prefix },
	);
	if (resolved === undefined) return undefined;
	return {
		source: resolved.source,
		port: createVercelBlobEphemeralState({
			...rest,
			sdk: sdk ?? vercelBlobSdk,
			storeId: resolved.storeId,
		}),
	};
}
