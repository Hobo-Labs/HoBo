/**
 * `@hobo/adapter-hono` — L2 framework adapter.
 *
 * Wires Hono apps into HoBo bindle HTTP entrypoints without putting Hono in core.
 */

// public-contract: the adapter package id consumers resolve entrypoints by.
export const HOBO_ADAPTER_HONO_PACKAGE = "@hobo/adapter-hono" as const;
// public-contract: the framework tag recorded on generated entrypoints.
export const HOBO_ADAPTER_HONO_FRAMEWORK = "hono" as const;

export {
	type BindleHttpEntrypoint,
	type FetchHandler,
	type HonoFetchApp,
	honoEntrypoint,
	isHonoFetchApp,
	toFetchHandler,
} from "./fetch.js";
