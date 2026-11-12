// In-memory upstreams for the reference components, used by the
// conformance kit and the CD platform matrix. Each fake checks the bearer
// token the host attaches (so a run without host-side injection fails) and
// keeps its state in memory; nothing is persisted.
import type { HttpTransport, TransportRequest, TransportResponse } from "@hobo/core";

/** Deterministic Last-Modified stamp (no ambient clock). */
const STAMP = "Wed, 11 Nov 2026 00:00:00 GMT";

interface StoredObject {
	readonly body: string;
	readonly digest: string;
	readonly contentType: string;
	readonly mode: string;
}

export interface FakeEndpoint {
	readonly transport: HttpTransport;
	readonly objects: ReadonlyMap<string, StoredObject>;
}

function response(status: number, body = "", headers: Record<string, string> = {}): TransportResponse {
	return { status, headers, body };
}

function authorized(request: TransportRequest, token: string): boolean {
	return request.headers.authorization === `Bearer ${token}`;
}

/**
 * A static host that accepts `PUT <path>` with `x-hobo-artifact-digest`,
 * answers `GET` with the digest and a `last-modified`, and `DELETE`.
 * The health path answers 200 without auth.
 */
export function createFakeUploadEndpoint(options: {
	readonly host: string;
	readonly token: string;
	readonly healthPath?: string;
}): FakeEndpoint {
	const objects = new Map<string, StoredObject>();
	const healthPath = options.healthPath ?? "/healthz";
	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		if (url.hostname !== options.host) return response(502, "unknown host");
		if (url.pathname === healthPath && request.method === "GET") return response(200, "ok");
		if (!authorized(request, options.token)) return response(401, "unauthorized");
		const key = url.pathname;
		const stored = objects.get(key);
		if (request.method === "GET" || request.method === "HEAD") {
			if (stored === undefined) return response(404);
			return response(200, request.method === "GET" ? stored.body : "", {
				"x-hobo-artifact-digest": stored.digest,
				"content-type": stored.contentType,
				"cache-control": "public, max-age=60",
				"last-modified": STAMP,
			});
		}
		if (request.method === "PUT") {
			objects.set(key, {
				body: request.body ?? "",
				digest: request.headers["x-hobo-artifact-digest"] ?? "",
				contentType: request.headers["content-type"] ?? "application/octet-stream",
				mode: "",
			});
			return response(stored === undefined ? 201 : 200);
		}
		if (request.method === "DELETE") {
			objects.delete(key);
			return response(stored === undefined ? 404 : 204);
		}
		return response(405);
	};
	return { transport, objects };
}

/**
 * The agent-local SFTP bridge API (see components/sftp-static): files under
 * `/v1/files/<path>`, a prefix listing, and a health path.
 */
export function createFakeSftpBridge(options: {
	readonly host: string;
	readonly token: string;
}): FakeEndpoint {
	const objects = new Map<string, StoredObject>();
	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		if (url.hostname !== options.host) return response(502, "unknown host");
		if (url.pathname === "/v1/health") return response(200, "ok");
		if (!authorized(request, options.token)) return response(401, "unauthorized");
		if (url.pathname === "/v1/files" && request.method === "GET") {
			const prefix = url.searchParams.get("prefix") ?? "/";
			const listed = [...objects.entries()]
				.filter(([path]) => path.startsWith(prefix))
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([path, stored]) => ({ path, sha256: stored.digest }));
			return response(200, JSON.stringify(listed), { "content-type": "application/json" });
		}
		if (!url.pathname.startsWith("/v1/files/")) return response(404);
		const path = decodeURIComponent(url.pathname.slice("/v1/files".length));
		const stored = objects.get(path);
		if (request.method === "GET") {
			if (stored === undefined) return response(404);
			return response(200, stored.body, {
				"x-hobo-sha256": stored.digest,
				"x-hobo-file-mode": stored.mode,
				"last-modified": STAMP,
			});
		}
		if (request.method === "PUT") {
			objects.set(path, {
				body: request.body ?? "",
				digest: request.headers["x-hobo-sha256"] ?? "",
				contentType: "application/octet-stream",
				mode: request.headers["x-hobo-file-mode"] ?? "0644",
			});
			return response(stored === undefined ? 201 : 200);
		}
		if (request.method === "DELETE") {
			objects.delete(path);
			return response(stored === undefined ? 404 : 204);
		}
		return response(405);
	};
	return { transport, objects };
}
