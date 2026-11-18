import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
	type FuzzRequest,
	type FuzzResponse,
	handleControlRequest,
} from "./api-fuzz.js";
import type { FuzzValue } from "./manifest.js";
import { ControlModel } from "./model.js";

const MAX_BODY_BYTES = 65_536;

type MutableFuzzRequest = {
	-readonly [Key in keyof FuzzRequest]: FuzzRequest[Key];
};

export interface ControlFuzzServer {
	readonly url: string;
	readonly requests: () => number;
	readonly operations: () => readonly string[];
	close(): Promise<void>;
}

function respond(
	response: ServerResponse,
	status: number,
	body: FuzzResponse["body"],
): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function dispatch(
	world: ControlModel,
	request: IncomingMessage,
	response: ServerResponse,
	operations: Set<string>,
): Promise<void> {
	const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	const expected =
		path === "/v1/bindles" ||
		/^\/v1\/bindles\/[^/]+\/(apply|destroy)$/.test(path)
			? "POST"
			: /^\/v1\/tenants\/[^/]+\/resources$/.test(path)
				? "GET"
				: undefined;
	if (expected && request.method !== expected) {
		response.setHeader("allow", expected);
		respond(response, 405, { ok: false, code: "method-not-allowed" });
		request.resume();
		return;
	}
	if (expected && request.method === expected) {
		if (path === "/v1/bindles") operations.add("createBindle");
		else if (path.endsWith("/apply")) operations.add("applyBindle");
		else if (path.endsWith("/destroy")) operations.add("destroyBindle");
		else operations.add("listResources");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size <= MAX_BODY_BYTES) chunks.push(bytes);
	}
	if (size > MAX_BODY_BYTES) {
		respond(response, 413, { ok: false, code: "body-too-large" });
		return;
	}
	let body: FuzzValue;
	if (size > 0) {
		const contentType = request.headers["content-type"]
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase();
		if (contentType !== "application/json") {
			respond(response, 415, { ok: false, code: "unsupported-media-type" });
			return;
		}
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			respond(response, 400, { ok: false, code: "invalid-json" });
			return;
		}
	}
	const tenant = request.headers["x-hobo-tenant"];
	const input: MutableFuzzRequest = {
		method: request.method ?? "",
		path,
	};
	if (tenant !== undefined && !Array.isArray(tenant)) input.tenantId = tenant;
	if (body !== undefined) input.body = body;
	const result = handleControlRequest(world, input);
	respond(response, result.status, result.body);
}

function isAddressInfo(
	value: AddressInfo | string | null,
): value is AddressInfo {
	return value !== null && Object(value) === value;
}

export async function createControlFuzzServer(): Promise<ControlFuzzServer> {
	const world = new ControlModel();
	let count = 0;
	const operations = new Set<string>();
	const server = createServer((request, response) => {
		count++;
		dispatch(world, request, response, operations).catch(() => {
			if (!response.headersSent)
				respond(response, 500, { ok: false, code: "unexpected-error" });
			else response.destroy();
		});
	});
	server.requestTimeout = 10_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!isAddressInfo(address)) {
		server.close();
		throw new Error("control fuzz server did not bind");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests: () => count,
		operations: () => [...operations].sort(),
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
