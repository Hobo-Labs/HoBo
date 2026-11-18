import type {
	ComponentExport,
	HttpRequest,
	JsonValue,
	ParsedComponentDescriptor,
} from "@hobo/core";
import { HTTP_INCOMING_HANDLER } from "@hobo/runtime-local";
import type { FetchHandler } from "./bare-metal-host.js";
import { isJsonObject, isJsonString } from "./json.js";

function parseHttpRequest(value: JsonValue | undefined): HttpRequest {
	if (
		!isJsonObject(value) ||
		!isJsonString(value.method) ||
		!isJsonString(value.path) ||
		!isJsonString(value.body) ||
		!Array.isArray(value.headers)
	) {
		throw new TypeError("invalid component HTTP request");
	}
	const headers: [string, string][] = [];
	for (const pair of value.headers) {
		if (
			!Array.isArray(pair) ||
			pair.length !== 2 ||
			!isJsonString(pair[0]) ||
			!isJsonString(pair[1])
		) {
			throw new TypeError("invalid component HTTP headers");
		}
		headers.push([pair[0], pair[1]]);
	}
	return {
		method: value.method,
		path: value.path,
		headers,
		body: value.body,
	};
}

function httpComponentExport(
	handler: FetchHandler,
	bodyEncoding: "utf8" | "latin1",
): ComponentExport {
	return async (...args) => {
		const request = parseHttpRequest(args[0]);
		const webRequest = new Request(`http://component.local${request.path}`, {
			method: request.method,
			headers: Object.fromEntries(request.headers),
			...(request.body && request.method !== "GET" && request.method !== "HEAD"
				? { body: request.body }
				: undefined),
		});
		const response = await handler(webRequest);
		const body =
			bodyEncoding === "latin1"
				? Buffer.from(await response.arrayBuffer()).toString("latin1")
				: await response.text();
		return {
			status: response.status,
			headers: [...response.headers.entries()],
			body,
		};
	};
}

export function createHttpComponentDescriptor(
	id: string,
	handler: FetchHandler,
	bodyEncoding: "utf8" | "latin1",
): ParsedComponentDescriptor {
	return {
		parsed: true,
		id,
		imports: [],
		exports: {
			[HTTP_INCOMING_HANDLER]: {
				handle: httpComponentExport(handler, bodyEncoding),
			},
		},
	};
}
