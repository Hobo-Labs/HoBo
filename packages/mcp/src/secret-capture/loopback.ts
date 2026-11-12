/**
 * The fallback capture page, for an MCP host without MCP Apps: the MCP
 * server process serves the same form on 127.0.0.1, and the owner opens it in
 * their own browser (the host opens it after the owner consents, for a host
 * with URL-mode elicitation). The value goes from that browser to this
 * process over loopback, sealed, and from here to the secret store. The host
 * and the model see the page's address, never what is typed into it.
 *
 * Defences, each covered by a test:
 * - bound to 127.0.0.1 only, on a port the OS picks;
 * - the `Host` header must name that exact address and port (DNS rebinding),
 *   and a POST's `Origin` must be that origin (cross-site form posts);
 * - the page's one-time token is the URL fragment, which no request carries,
 *   and is compared against a digest in constant time;
 * - `Content-Security-Policy` with a per-response nonce, `default-src 'none'`,
 *   `connect-src 'self'`, no framing, `Referrer-Policy: no-referrer`,
 *   `Cache-Control: no-store`;
 * - request bodies are bounded (64 KiB) and never logged; this module writes
 *   no log line at all.
 */

import { randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";

const MAX_BODY_BYTES = 64 * 1024;
const PAGE_PATH = /^\/capture\/(cap_[A-Za-z0-9_-]{22})$/u;

export type LoopbackAnswer = Readonly<{ status: number; body: JsonValue }>;

export interface LoopbackCaptureHandlers {
	/** The page for an open ticket, or undefined when it is not open. */
	page(ticketId: string, nonce: string): string | undefined;
	/** A form's submission: `token` from the fragment, `sealed` as sent. */
	submit(
		ticketId: string,
		token: string,
		sealed: JsonValue,
	): Promise<LoopbackAnswer>;
}

export interface LoopbackCapturePage {
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;
	close(): Promise<void>;
}

function headers(nonce: string | undefined) {
	const scripts = nonce === undefined ? "'none'" : `'nonce-${nonce}'`;
	return {
		"cache-control": "no-store",
		pragma: "no-cache",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
		"cross-origin-opener-policy": "same-origin",
		"cross-origin-resource-policy": "same-origin",
		"content-security-policy": `default-src 'none'; script-src ${scripts}; style-src ${scripts}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
	};
}

function reply(
	response: ServerResponse,
	status: number,
	body: string,
	type: string,
	nonce?: string,
): void {
	response.writeHead(status, {
		...headers(nonce),
		"content-type": type,
		"content-length": String(Buffer.byteLength(body)),
	});
	response.end(body);
}

function replyJson(
	response: ServerResponse,
	status: number,
	body: JsonValue,
): void {
	reply(response, status, JSON.stringify(body), "application/json");
}

const CLOSED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HoBo: capture closed</title></head><body><main><h1>This capture is closed</h1><p>It was stored, expired or never existed. Ask the agent to open a new one.</p></main></body></html>`;

async function readBody(request: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += part.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(part);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function startLoopbackCapturePage(
	handlers: LoopbackCaptureHandlers,
): Promise<LoopbackCapturePage> {
	let origin = "";
	let host = "";

	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		// DNS rebinding: a name that resolves here is still not this origin.
		if (request.headers.host !== host) {
			reply(response, 421, "misdirected", "text/plain; charset=utf-8");
			return;
		}
		const url = new URL(request.url ?? "/", origin);
		const match = PAGE_PATH.exec(url.pathname);
		if (!match || url.search !== "") {
			reply(response, 404, "not found", "text/plain; charset=utf-8");
			return;
		}
		const ticketId = match[1] ?? "";
		if (request.method === "GET") {
			const nonce = randomBytes(18).toString("base64url");
			const page = handlers.page(ticketId, nonce);
			if (page === undefined) {
				reply(response, 410, CLOSED_PAGE, "text/html; charset=utf-8");
				return;
			}
			reply(response, 200, page, "text/html; charset=utf-8", nonce);
			return;
		}
		if (request.method !== "POST") {
			reply(response, 405, "method not allowed", "text/plain; charset=utf-8");
			return;
		}
		const fetchSite = request.headers["sec-fetch-site"];
		if (
			request.headers.origin !== origin ||
			(fetchSite !== undefined && fetchSite !== "same-origin") ||
			!(request.headers["content-type"] ?? "").startsWith("application/json")
		) {
			replyJson(response, 403, {
				code: "SECRET_CAPTURE_INVALID_INPUT",
				message: "Only this page may submit to this capture.",
			});
			return;
		}
		const raw = await readBody(request);
		let body: JsonValue | undefined;
		try {
			body = raw === undefined ? undefined : JSON.parse(raw);
		} catch {
			body = undefined;
		}
		if (
			body === undefined ||
			!isJsonObject(body) ||
			!isJsonString(body.token) ||
			body.sealed === undefined
		) {
			replyJson(response, 400, {
				code: "SECRET_CAPTURE_INVALID_INPUT",
				message: "The submission is not one this page sends.",
			});
			return;
		}
		const answer = await handlers.submit(ticketId, body.token, body.sealed);
		replyJson(response, answer.status, answer.body);
	}

	const server: Server = createServer((request, response) => {
		handle(request, response).catch(() => {
			if (!response.headersSent)
				reply(response, 500, "error", "text/plain; charset=utf-8");
			else response.end();
		});
	});
	// A malformed request is dropped; nothing about it is logged.
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	// The page must not keep the MCP server alive after its input ends.
	server.unref();
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	host = `127.0.0.1:${port}`;
	origin = `http://${host}`;
	return {
		origin,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
