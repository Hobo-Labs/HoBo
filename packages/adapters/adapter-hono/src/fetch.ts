import { isJsonObject } from "./json.js";

export interface HonoFetchApp {
	readonly fetch: (request: Request) => Response | Promise<Response>;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export type BindleHttpEntrypoint = () => FetchHandler;

export function toFetchHandler(app: HonoFetchApp): FetchHandler {
	return (request) => app.fetch(request);
}

export function honoEntrypoint(app: HonoFetchApp): BindleHttpEntrypoint {
	const handler = toFetchHandler(app);
	return () => handler;
}

export function isHonoFetchApp<T>(value: T): value is T & HonoFetchApp {
	if (!isJsonObject(value) || !("fetch" in value)) return false;
	const host: HonoFetchApp = value as never;
	return host.fetch instanceof Function;
}
