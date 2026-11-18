export const HOBO_ADAPTER_HONO_PACKAGE = "@hobo/adapter-hono" as const;
export const HOBO_ADAPTER_HONO_FRAMEWORK = "hono" as const;

export {
	type BindleHttpEntrypoint,
	type FetchHandler,
	type HonoFetchApp,
	honoEntrypoint,
	isHonoFetchApp,
	toFetchHandler,
} from "./fetch.js";
