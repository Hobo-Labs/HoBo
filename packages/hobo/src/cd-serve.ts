/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening -- SAFETY: the HTTP edge: node request headers and error values are untrusted and only copied or stringified. */
/**
 * `hobo serve cd` — the CD conductor service (ADR-0182 C2/C13).
 *
 * One process hosts:
 * - the `@hobo/cd/service` tick loop (sources → … → retention) and a
 *   conductor reconciler over the Station's MANAGED Camps;
 * - one HTTP mount at `/v1/cd/`: the read API (`createCdControlApi`) for
 *   operators and the delivery feed for enrolled agents (agents connect
 *   outbound to this mount; the Station never dials an agent, I3);
 * - `/healthz` (liveness) and `/readyz` (journal, leases, steps).
 *
 * `--simulate` reaches the labelled fixtures only; the service says so in its
 * banner and in `/readyz`.
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { FeedRequest, FeedResponse } from "@hobo/cd";
import { cdJson, composeCdHost } from "./cd-host.js";
import type { CdRuntime } from "./cd-runtime.js";

export type CdServer = Readonly<{
	url: string;
	port: number;
	reconcilers: number;
	refusals: readonly string[];
	close(signal?: AbortSignal): Promise<void>;
}>;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 4 MiB");
		chunks.push(buf);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

function headersOf(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return out;
}

async function send(
	res: ServerResponse,
	response: FeedResponse,
): Promise<void> {
	res.writeHead(response.status, { ...response.headers });
	const body = response.body;
	if (body instanceof Uint8Array) {
		res.end(Buffer.from(body));
		return;
	}
	for await (const chunk of body) {
		if (res.destroyed) break;
		res.write(Buffer.from(chunk));
	}
	res.end();
}

/** Start the conductor service over an opened CD runtime. */
export async function startCdServer(
	input: Readonly<{
		runtime: CdRuntime;
		host: string;
		port: number;
		log: (line: string) => void;
	}>,
): Promise<CdServer> {
	const { runtime } = input;
	const { config } = runtime;
	const host = await composeCdHost({
		runtime,
		holderId: `hobo-serve-cd:${process.pid}`,
		principalId: `hobo-serve-cd:${config.stationId}`,
	});
	const { service, refusals } = host;
	const abort = new AbortController();
	const server = createServer((req, res) => {
		void (async () => {
			try {
				const path = (req.url ?? "/").split("?")[0] ?? "/";
				const request: FeedRequest = {
					method: req.method ?? "GET",
					path: req.url ?? path,
					headers: headersOf(req),
					body: await readBody(req),
				};
				// A client hang-up aborts its long-poll or stream.
				const perRequest = new AbortController();
				res.on("close", () => perRequest.abort());
				const signal = AbortSignal.any([abort.signal, perRequest.signal]);
				await send(res, await host.handle(request, signal));
			} catch {
				if (!res.headersSent)
					await send(
						res,
						cdJson(500, {
							ok: false,
							code: "cd-serve-error",
							message: "The CD request could not be processed.",
						}),
					);
				else res.destroy();
			}
		})();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(input.port, input.host, () => resolve());
	});
	const address = server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : input.port;
	await service.start();
	const url = `http://${input.host}:${port}`;
	input.log(
		`hobo serve cd: ${url}${host.pathPrefix} (tenant=${config.tenant} station=${config.stationId} store=${config.store.backend}${config.simulate ? " SIMULATED" : ""}) reconcilers=${host.reconcilers}${refusals.length > 0 ? ` refused=${refusals.join("; ")}` : ""}`,
	);
	return Object.freeze({
		url,
		port,
		reconcilers: host.reconcilers,
		refusals,
		async close(signal?: AbortSignal) {
			abort.abort();
			await service.drain(signal ?? AbortSignal.timeout(30_000));
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await runtime.close();
		},
	});
}
