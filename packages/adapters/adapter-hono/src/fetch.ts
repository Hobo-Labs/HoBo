import { isJsonObject } from "./json.js";

export interface HonoFetchApp {
	readonly fetch: (request: Request) => Response | Promise<Response>;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export type BindleHttpEntrypoint = () => FetchHandler;

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

export function isHonoFetchApp<T>(value: T): value is T & HonoFetchApp {
	if (!isJsonObject(value) || !("fetch" in value)) return false;
	const host: HonoFetchApp = value as never;
	return host.fetch instanceof Function;
}
