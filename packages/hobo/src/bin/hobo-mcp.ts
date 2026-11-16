#!/usr/bin/env node
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";

import { z } from "zod";

import { initializeResult, OPENSESAME_CREDENTIALS } from "../mcp-handshake.js";

// The `hobo-mcp` entry point. A host starts it and waits a fixed time (30
// seconds in Claude Code) for the answer to `initialize`; on a machine that
// has just booted, loading the composed CLI can take longer than that. So
// this file imports nothing heavy: it answers `initialize` at once from the
// handshake module, and hands every line, `initialize` included, to the full
// server as soon as it has loaded (mcp-serve.ts), dropping the full server's
// own answer to that one `initialize`. Requests that arrive meanwhile wait in
// order; nothing is timed.

/** The host's `initialize`, the one request answered here. */
const Initialize = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number()]),
	method: z.literal("initialize"),
	params: z
		.object({ protocolVersion: z.string().optional() })
		.loose()
		.optional(),
});
/** A successful response (a result, no method) and the request it answers. */
const Response = z.object({
	id: z.union([z.string(), z.number(), z.null()]),
	method: z.undefined().optional(),
	result: z.record(z.string(), z.json()),
});

const parsed = <T>(schema: z.ZodType<T>, line: string): T | undefined => {
	try {
		const result = schema.safeParse(JSON.parse(line));
		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
};

async function main(): Promise<number> {
	// Under OpenSesame the server relaunches itself with stdin passed
	// through, so this process must not read stdin first.
	if (process.env.HOBO_CREDENTIALS === OPENSESAME_CREDENTIALS)
		return (await import("../mcp-serve.js")).runHoboMcp();
	const toServer = new PassThrough();
	let answered: string | undefined;
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	lines.on("line", (line) => {
		const initialize =
			answered === undefined ? parsed(Initialize, line) : undefined;
		if (initialize !== undefined) {
			answered = String(initialize.id);
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: initialize.id,
					result: initializeResult(initialize.params?.protocolVersion, true),
				})}\n`,
			);
		}
		toServer.write(`${line}\n`);
	});
	lines.on("close", () => toServer.end());
	// The full server's output, less its answer to the `initialize` already
	// answered above.
	let pending = "";
	let dropped = false;
	const fromServer = new Writable({
		write(chunk: Buffer | string, _encoding, done) {
			pending += chunk.toString();
			for (
				let nl = pending.indexOf("\n");
				nl !== -1;
				nl = pending.indexOf("\n")
			) {
				const line = pending.slice(0, nl + 1);
				pending = pending.slice(nl + 1);
				const response = dropped ? undefined : parsed(Response, line);
				if (response !== undefined && String(response.id) === answered) {
					dropped = true;
					continue;
				}
				process.stdout.write(line);
			}
			done();
		},
	});
	const { serveHoboMcpOn } = await import("../mcp-serve.js");
	return serveHoboMcpOn({ input: toServer, output: fromServer });
}

process.exitCode = await main();
