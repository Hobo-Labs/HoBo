import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import https, { type RequestOptions } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeSandboxEgressTransport } from "../src/sandbox-egress-proxy.js";

type StandInIncoming = PassThrough & {
	statusCode: number | undefined;
	headers: IncomingHttpHeaders;
};

class StandInRequest extends EventEmitter {
	readonly written: Uint8Array[] = [];
	ended = false;
	destroyed: Error | undefined;
	constructor(
		readonly options: RequestOptions,
		private readonly onResponse: (incoming: StandInIncoming) => void,
		private readonly backpressure: boolean,
	) {
		super();
	}
	write(chunk: Uint8Array): boolean {
		this.written.push(chunk);
		if (!this.backpressure) return true;
		setTimeout(() => this.emit("drain"), 0);
		return false;
	}
	end(): void {
		this.ended = true;
	}
	destroy(error: Error): void {
		this.destroyed = error;
		this.emit("error", error);
	}
	respond(
		status: number | undefined,
		headers: IncomingHttpHeaders,
		body = "",
	): void {
		const incoming = Object.assign(new PassThrough(), {
			statusCode: status,
			headers,
		});
		this.onResponse(incoming);
		incoming.end(body);
	}
}

const requests: StandInRequest[] = [];
let backpressure = false;
beforeEach(() => {
	requests.length = 0;
	backpressure = false;
	vi.spyOn(https, "request").mockImplementation(
		vi
			.fn()
			.mockImplementation(
				(
					options: RequestOptions,
					onResponse: (incoming: StandInIncoming) => void,
				) => {
					const request = new StandInRequest(options, onResponse, backpressure);
					requests.push(request);
					return request;
				},
			),
	);
	syncBuiltinESMExports();
});
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

function last(): StandInRequest {
	const request = requests.at(-1);
	if (!request) throw new Error("no request was made");
	return request;
}
function input(body?: string) {
	return {
		url: new URL("https://github.com/org/repo/info/refs?service=git"),
		address: "140.82.112.3",
		method: body === undefined ? "GET" : "POST",
		headers: new Headers({ accept: "*/*" }),
		body:
			body === undefined
				? null
				: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(body));
							controller.close();
						},
					}),
		signal: new AbortController().signal,
	};
}

describe("the Node egress transport", () => {
	it("pins the verified address and streams the response with every header value", async () => {
		const pending = nodeSandboxEgressTransport(input());
		const request = last();
		expect(request.options).toMatchObject({
			hostname: "github.com",
			servername: "github.com",
			port: 443,
			family: 4,
			path: "/org/repo/info/refs?service=git",
		});
		const looked = vi.fn();
		request.options.lookup?.("github.com", {}, looked);
		expect(looked).toHaveBeenCalledWith(null, "140.82.112.3", 4);
		expect(request.ended).toBe(true);
		request.respond(
			200,
			{ "set-cookie": ["a=1", "b=2"], "x-one": "1", "x-none": undefined },
			"hello",
		);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		expect(response.headers.get("x-one")).toBe("1");
		expect(await response.text()).toBe("hello");
	});

	it("carries no body where none is allowed, and treats a missing status as a bad gateway", async () => {
		const noContent = nodeSandboxEgressTransport(input());
		last().respond(204, {});
		expect((await noContent).body).toBeNull();
		const unknown = nodeSandboxEgressTransport(input());
		last().respond(undefined, {});
		expect((await unknown).status).toBe(502);
	});

	it("streams the upload, waiting for drain under backpressure", async () => {
		backpressure = true;
		const pending = nodeSandboxEgressTransport(input("payload"));
		const request = last();
		await vi.waitFor(() => expect(request.ended).toBe(true));
		expect(Buffer.concat(request.written).toString()).toBe("payload");
		request.respond(200, {}, "ok");
		expect(await (await pending).text()).toBe("ok");
	});

	it("tears down an upload whose source fails", async () => {
		const failing = {
			...input(),
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				pull() {
					throw new Error("source broke");
				},
			}),
		};
		await expect(nodeSandboxEgressTransport(failing)).rejects.toThrow(
			/source broke/u,
		);
		expect(last().destroyed?.message).toBe("source broke");
	});

	it("destroys a request whose upstream times out", async () => {
		const pending = nodeSandboxEgressTransport(input());
		last().emit("timeout");
		await expect(pending).rejects.toThrow(/upstream timeout/u);
	});
});
