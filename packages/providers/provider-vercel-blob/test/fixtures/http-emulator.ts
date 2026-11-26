/**
 * A local HTTP stand-in for the Vercel Blob API, backed by the in-memory
 * store, so the pinned `@vercel/blob` SDK runs unmodified against it: the
 * binding's calls go through the SDK's own request building, header mapping,
 * error decoding and response parsing, and only the far end is ours.
 *
 * Routes are the ones `@vercel/blob` 2.8.2 sends (read from its
 * `dist/index.js` and `dist/chunk-*.js`): `PUT <api>/?pathname=` to upload,
 * `POST <api>/delete` with `{ urls }` to delete, `GET <api>?prefix=&limit=` to
 * list, and `GET <blob url>?cache=0` to read from origin. The API base comes
 * from `VERCEL_BLOB_API_URL`; a blob URL on the same origin is accepted by the
 * SDK's `get` (its documented local-emulator override). Errors are answered
 * the way the SDK decodes them: `{ error: { code, message } }`.
 *
 * Only the refusal of a create-only upload is a guess: the real API's code and
 * message for it are not documented, so it is answered as `bad_request` with
 * an "already exists" message.
 */
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { BlobError, BlobPreconditionFailedError } from "@vercel/blob";

import {
	createMemoryBlobSdk,
	type MemoryBlobSdk,
	type MemoryBlobSdkOptions,
} from "../../src/index.js";

/** Request headers the binding's behaviour depends on; recorded and pinned. */
export const PINNED_HEADERS = [
	"x-vercel-blob-access",
	"x-allow-overwrite",
	"x-if-match",
	"x-add-random-suffix",
	"x-content-type",
	"x-cache-control-max-age",
] as const;

export type RecordedRequest = {
	readonly method: string;
	readonly path: string;
	readonly query: Readonly<Record<string, string>>;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
};

export type EmulatorReply = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
};

export type BlobEmulator = {
	readonly origin: string;
	readonly apiUrl: string;
	readonly store: MemoryBlobSdk;
	readonly requests: RecordedRequest[];
	/** The reply to each recorded request, index-aligned with `requests`. */
	readonly replies: EmulatorReply[];
	/** Answer one request directly, without a socket (the pact's provider side). */
	answer(request: RecordedRequest): Promise<EmulatorReply>;
	close(): Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

export function recordRequest(
	method: string,
	url: URL,
	header: (name: string) => string | undefined,
	body: string,
): RecordedRequest {
	const headers: Record<string, string> = {};
	for (const name of PINNED_HEADERS) {
		const value = header(name);
		if (value !== undefined) headers[name] = value;
	}
	return {
		method,
		path: url.pathname,
		query: Object.fromEntries(url.searchParams),
		headers,
		body,
	};
}

type ReplyJson =
	| string
	| number
	| boolean
	| null
	| readonly ReplyJson[]
	| { readonly [field: string]: ReplyJson };

const json = (status: number, value: ReplyJson): EmulatorReply => ({
	status,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(value),
});

const apiError = (status: number, code: string, message: string) =>
	json(status, { error: { code, message } });

function errorReply(error: Error): EmulatorReply {
	if (error instanceof BlobPreconditionFailedError) {
		return apiError(
			412,
			"precondition_failed",
			"Precondition failed: ETag mismatch",
		);
	}
	if (error instanceof BlobError && /already exists/u.test(error.message)) {
		return apiError(
			400,
			"bad_request",
			"This blob already exists, use `allowOverwrite: true` if you want to overwrite it.",
		);
	}
	return apiError(500, "unknown_error", "emulator failure");
}

export async function startBlobEmulator(
	options: MemoryBlobSdkOptions = {},
): Promise<BlobEmulator> {
	const store = createMemoryBlobSdk(options);
	const requests: RecordedRequest[] = [];
	const replies: EmulatorReply[] = [];
	let origin = "";

	async function answer(request: RecordedRequest): Promise<EmulatorReply> {
		const { method, path, query, headers } = request;
		try {
			if (method === "PUT" && path === "/api/blob/") {
				if (headers["x-vercel-blob-access"] !== "private") {
					return apiError(
						400,
						"bad_request",
						"the emulator stores private blobs only",
					);
				}
				const pathname = query.pathname ?? "";
				const ifMatch = headers["x-if-match"];
				const base = {
					access: "private",
					contentType: headers["x-content-type"] ?? "",
					addRandomSuffix: false,
				} as const;
				const put = await store.put(
					pathname,
					request.body,
					ifMatch === undefined
						? { ...base, allowOverwrite: headers["x-allow-overwrite"] === "1" }
						: { ...base, allowOverwrite: true, ifMatch },
				);
				return json(200, {
					url: `${origin}/blob/${pathname}`,
					downloadUrl: `${origin}/blob/${pathname}?download=1`,
					pathname,
					contentType: headers["x-content-type"] ?? "",
					contentDisposition: "inline",
					etag: put.etag,
				});
			}
			if (method === "POST" && path === "/api/blob/delete") {
				// SAFETY: the SDK sends `{ urls: string[] }`; the pact pins it.
				const { urls } = JSON.parse(request.body) as { urls: string[] };
				const ifMatch = headers["x-if-match"];
				for (const url of urls) {
					await store.del(url, ifMatch === undefined ? {} : { ifMatch });
				}
				return json(200, {});
			}
			if (method === "GET" && (path === "/api/blob" || path === "/api/blob/")) {
				const page = {
					prefix: query.prefix ?? "",
					limit: Number(query.limit ?? "1000"),
				};
				const listed = await store.list(
					query.cursor === undefined ? page : { ...page, cursor: query.cursor },
				);
				const listing = {
					blobs: listed.blobs.map((blob) => ({
						url: `${origin}/blob/${blob.pathname}`,
						downloadUrl: `${origin}/blob/${blob.pathname}?download=1`,
						pathname: blob.pathname,
						size: 0,
						uploadedAt: blob.uploadedAt.toISOString(),
						etag: blob.etag,
					})),
					hasMore: listed.hasMore,
				};
				return json(
					200,
					listed.cursor === undefined
						? listing
						: { ...listing, cursor: listed.cursor },
				);
			}
			if (method === "GET" && path.startsWith("/blob/")) {
				if (query.cache !== "0") {
					return apiError(
						400,
						"bad_request",
						"the emulator serves origin reads (cache=0) only",
					);
				}
				const read = await store.get(decodeURIComponent(path.slice(6)), {
					access: "private",
					useCache: false,
				});
				if (read === null || read.stream === null) {
					return { status: 404, headers: {}, body: "" };
				}
				return {
					status: 200,
					headers: { "content-type": "application/json", etag: read.blob.etag },
					body: await new Response(read.stream).text(),
				};
			}
			return apiError(400, "bad_request", `no route for ${method} ${path}`);
		} catch (error) {
			if (error instanceof Error) return errorReply(error);
			throw error;
		}
	}

	const server = createServer(
		(incoming: IncomingMessage, outgoing: ServerResponse) => {
			void (async () => {
				const url = new URL(incoming.url ?? "/", origin);
				const recorded = recordRequest(
					incoming.method ?? "GET",
					url,
					(name) => {
						const value = incoming.headers[name];
						return Array.isArray(value) ? value.join(",") : value;
					},
					await readBody(incoming),
				);
				const index = requests.push(recorded) - 1;
				const reply = await answer(recorded);
				replies[index] = reply;
				outgoing.writeHead(reply.status, reply.headers);
				outgoing.end(reply.body);
			})();
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a TCP server listening on a port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${port}`;
	return {
		origin,
		apiUrl: `${origin}/api/blob`,
		store,
		requests,
		replies,
		answer,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
