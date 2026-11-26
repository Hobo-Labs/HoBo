/**
 * Hono → HoBo fetch boundary.
 *
 * HoBo local component hosts invoke bindle entrypoints as:
 *   `() => (Request) => Response | Promise<Response>`
 *
 * Hono apps expose `.fetch` with that signature. This adapter is the only
 * place `@hobo/*` packages should mention Hono types — core stays framework-free.
 */

/** Minimal surface we need from Hono (avoids hard-coupling to every Hono release type). */
import { isJsonObject } from "./json.js";

export interface HonoFetchApp {
	readonly fetch: (request: Request) => Response | Promise<Response>;
}

/** Framework-free handler shape used by local Yard / Camp hosts. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Bindle entrypoint thunk: `b.api(honoEntrypoint(app))`. */
export type BindleHttpEntrypoint = () => FetchHandler;

/**
 * Wrap a Hono app as a single fetch handler (no thunk).
 * Useful when a host already expects `(Request) => Response`.
 */
export function toFetchHandler(app: HonoFetchApp): FetchHandler {
	return (request) => app.fetch(request);
}

/**
 * Bindle entrypoint factory: returns the thunk HoBo hosts call to resolve a handler.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { honoEntrypoint } from "@hobo/adapter-hono";
 *
 * const api = new Hono().get("/hello", (c) => c.json({ ok: true }));
 * b.api(honoEntrypoint(api));
 * ```
 */
export function honoEntrypoint(app: HonoFetchApp): BindleHttpEntrypoint {
	const handler = toFetchHandler(app);
	return () => handler;
}

/** Type guard for objects that look like a Hono app (have a fetch method). */
export function isHonoFetchApp<T>(value: T): value is T & HonoFetchApp {
	if (!isJsonObject(value) || !("fetch" in value)) return false;
	// SAFETY: Hono apps expose fetch on the host object at this boundary.
	const host: HonoFetchApp = value as never;
	return host.fetch instanceof Function;
}
