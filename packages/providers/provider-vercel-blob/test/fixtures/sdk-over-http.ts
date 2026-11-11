/**
 * The real, pinned `@vercel/blob` SDK pointed at a local emulator.
 *
 * Two test-only adjustments, both outside the binding: a dummy read-write
 * token is passed explicitly (so the SDK neither looks for an OIDC token nor
 * reads a credential from the environment), and `get` is given the blob's URL
 * on the emulator's origin instead of a pathname (from a pathname the SDK
 * builds a `*.private.blob.vercel-storage.com` URL). Everything else — option
 * to header mapping, `?cache=0`, error decoding — is the SDK's own.
 *
 * `VERCEL_BLOB_API_URL` points the SDK's API calls at the emulator and
 * `VERCEL_BLOB_RETRIES=0` turns its automatic retry off, so each port call
 * maps to exactly the requests the binding asked for.
 */
import { del, get, list, put } from "@vercel/blob";

import type { VercelBlobSdk } from "../../src/index.js";

/** Not a credential: the SDK only parses the store id out of it. */
export const EMULATOR_TOKEN = "vercel_blob_rw_emulatorstore_notasecret";

export function sdkOverHttp(origin: string): VercelBlobSdk {
	const token = EMULATOR_TOKEN;
	return {
		put: (pathname, body, options) =>
			put(pathname, body, { ...options, token }),
		get: (pathname, options) =>
			get(`${origin}/blob/${pathname}`, { ...options, token }),
		del: (pathname, options) => del(pathname, { ...options, token }),
		list: (options) => list({ ...options, token }),
	};
}

/** Point the SDK at `apiUrl` with no retries; returns the restore function. */
export function useEmulatorEnv(apiUrl: string): () => void {
	const saved = {
		VERCEL_BLOB_API_URL: process.env.VERCEL_BLOB_API_URL,
		VERCEL_BLOB_RETRIES: process.env.VERCEL_BLOB_RETRIES,
	};
	process.env.VERCEL_BLOB_API_URL = apiUrl;
	process.env.VERCEL_BLOB_RETRIES = "0";
	return () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}
