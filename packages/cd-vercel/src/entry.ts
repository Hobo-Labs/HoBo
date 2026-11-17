import type { IncomingMessage, ServerResponse } from "node:http";

import type { FeedRequest, FeedResponse } from "@hobo/cd";
import type { CdHost } from "@hobo/hobo/cd-platform";

import { composeVercelCdHost, memoizedCdHost } from "./compose.js";
import {
	CdStoreBindingError,
	openCdStore,
	readCdStoreCoordinates,
} from "./store.js";

// The Vercel entries (`api/cd.ts`, `api/tick.ts`). `/healthz` answers 200
// whatever CD's state (the function is up) and names the build's commit;
// everything else waits for the CD host, and answers 503 while it cannot
// compose (`/readyz` says why, by code).

const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

/** What the function answers itself, before or around the CD mount. */
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

/** The Node function handler for the CD mount. */
export function createCdHttpEntry(
	load: () => Promise<CdHost>,
	options: Readonly<{ commit?: string | null }> = {},
) {
	const commit = options.commit ?? null;
	return async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
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
					// Each known refusal is a CdStoreBindingError with a code.
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
				path: request.url ?? path,
				headers: headersOf(request),
				body: await readBody(request),
			};
			const perRequest = new AbortController();
			response.on("close", () => perRequest.abort());
			await send(response, await host.handle(feed, perRequest.signal));
		} catch (error) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			sendJson(response, 500, {
				ok: false,
				code: "cd-serve-error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};
}

/** One scheduled pass; what the tick function runs per delivery. */
export async function runCdPass(load: () => Promise<CdHost>) {
	const host = await load();
	return host.pass();
}

/** The build's commit, from Vercel's system environment. */
export function buildCommit(
	env: Readonly<Record<string, string | undefined>>,
): string | null {
	return env.VERCEL_GIT_COMMIT_SHA ?? null;
}

/** The CD host this instance composes, on the committed store binding. */
export const loadCdHost = memoizedCdHost(() =>
	composeVercelCdHost({
		env: process.env,
		cwd: process.cwd(),
		open: () => openCdStore(readCdStoreCoordinates()),
	}),
);

export const http = createCdHttpEntry(loadCdHost, {
	commit: buildCommit(process.env),
});
