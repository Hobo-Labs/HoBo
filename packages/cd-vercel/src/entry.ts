import type { IncomingMessage, ServerResponse } from "node:http";

import type { FeedRequest, FeedResponse } from "@hobo/cd";
import { parseReadRequest } from "@hobo/cd/service";
import type { CdHost } from "@hobo/hobo/cd-platform";

import { composeVercelCdHost, memoizedCdHost } from "./compose.js";
import {
	CdStoreBindingError,
	openCdStore,
	readCdStoreCoordinates,
} from "./store.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function headerValue(
	headers: IncomingMessage["headers"],
	name: string,
): string | undefined {
	const value = headers[name];
	if (value === undefined) return undefined;
	return Array.isArray(value) ? (value[0] ?? undefined) : value;
}

export function incomingRequestPath(request: IncomingMessage): string {
	const original = headerValue(request.headers, "x-vercel-original-url");
	if (original !== undefined && original.length > 0) {
		try {
			const parsed = new URL(original, "http://hobo-cd.local");
			return `${parsed.pathname}${parsed.search}`;
		} catch {
			return original.startsWith("/") ? original : `/${original}`;
		}
	}
	const invokePath = headerValue(request.headers, "x-vercel-invoke-path");
	if (invokePath !== undefined && invokePath.length > 0) {
		const path = invokePath.startsWith("/") ? invokePath : `/${invokePath}`;
		if (path.includes("?")) return path;
		const search = (request.url ?? "").split("?")[1];
		return search === undefined || search.length === 0
			? path
			: `${path}?${search}`;
	}
	return request.url ?? "/";
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 4 MiB");
		chunks.push(buffer);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

function headersOf(request: IncomingMessage): FeedRequest["headers"] {
	const headers: { [name: string]: string } = {};
	for (const [key, value] of Object.entries(request.headers))
		if (value !== undefined)
			headers[key.toLowerCase()] = Array.isArray(value)
				? value.join(", ")
				: value;
	return headers;
}

async function send(
	response: ServerResponse,
	feed: FeedResponse,
): Promise<void> {
	response.writeHead(feed.status, { ...feed.headers });
	if (feed.body instanceof Uint8Array) {
		response.end(Buffer.from(feed.body));
		return;
	}
	for await (const chunk of feed.body) {
		if (response.destroyed) break;
		response.write(Buffer.from(chunk));
	}
	response.end();
}

type CdOwnAnswer =
	| Readonly<{ ok: true; commit: string | null }>
	| Readonly<{ ready: false; started: false; code: string }>
	| Readonly<{ ok: false; code: string; message: string }>;

function sendJson(
	response: ServerResponse,
	status: number,
	value: CdOwnAnswer,
) {
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	response.end(JSON.stringify(value));
}

export type CdHttpEntryOptions = Readonly<{
	commit?: string | null;
	operatorReads?: "allow" | "deny";
}>;

function deniesOperatorRead(request: FeedRequest): boolean {
	const route = parseReadRequest(request);
	return !route.ok || route.value.kind !== "feed";
}

export function createCdHttpEntry(
	load: () => Promise<CdHost>,
	options: CdHttpEntryOptions = {},
) {
	const commit = options.commit ?? null;
	const operatorReads = options.operatorReads ?? "deny";
	return async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		const incoming = incomingRequestPath(request);
		const path = incoming.split("?")[0] ?? "/";
		if (request.method === "GET" && path === "/healthz") {
			sendJson(response, 200, { ok: true, commit });
			return;
		}
		let host: CdHost;
		try {
			host = await load();
		} catch (error) {
			if (path === "/readyz") {
				sendJson(response, 503, {
					ready: false,
					started: false,
					code:
						error instanceof CdStoreBindingError
							? error.code
							: "cd-start-failed",
				});
				return;
			}
			response.writeHead(503, { "Cache-Control": "no-store" });
			response.end();
			return;
		}
		try {
			const feed: FeedRequest = {
				method: request.method ?? "GET",
				path: incoming,
				headers: headersOf(request),
				body: await readBody(request),
			};
			const perRequest = new AbortController();
			response.on("close", () => perRequest.abort());
			if (path === "/healthz" || path === "/readyz") {
				await send(response, await host.handle(feed, perRequest.signal));
				return;
			}
			if (operatorReads === "deny" && deniesOperatorRead(feed)) {
				sendJson(response, 401, {
					ok: false,
					code: "cd-operator-read-denied",
					message: "Operator read routes are not exposed on this mount.",
				});
				return;
			}
			await send(response, await host.handle(feed, perRequest.signal));
		} catch {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			sendJson(response, 500, {
				ok: false,
				code: "cd-serve-error",
				message: "The CD request could not be processed.",
			});
		}
	};
}

export async function runCdPass(load: () => Promise<CdHost>) {
	const host = await load();
	return host.pass();
}

export function buildCommit(
	env: Readonly<Record<string, string | undefined>>,
): string | null {
	return env.VERCEL_GIT_COMMIT_SHA ?? null;
}

export const loadCdHost = memoizedCdHost(() =>
	composeVercelCdHost({
		env: process.env,
		cwd: process.cwd(),
		open: () => openCdStore(readCdStoreCoordinates()),
	}),
);

export const http = createCdHttpEntry(loadCdHost, {
	commit: buildCommit(process.env),
	operatorReads: "deny",
});
