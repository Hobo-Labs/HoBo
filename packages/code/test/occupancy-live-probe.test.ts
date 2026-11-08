import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isJsonString } from "../src/json.js";
import {
	isLoopbackUrlListening,
	listeningByUrl,
} from "../src/occupancy-live.js";

/**
 * The probe decides whether `hobo status` calls an endpoint `live` or
 * `last-seen:<date>`. A false negative here does not fail loudly — it tells
 * someone their running service is stale.
 *
 * These pin the direction that matters. The load-dependent half of the defect
 * they were written for is deliberately NOT reproduced here: the bug was that
 * the child process's wall-clock budget was `timeoutMs + 250`, which charged
 * Node interpreter startup to a network timeout, and a test that recreated the
 * load would be exactly the kind of clock-measuring test this repo has been
 * removing all day. The measurement lives in the source comment and the commit:
 * 0/40 false negatives idle, 5/40 under CPU load, 0/40 after the fix.
 *
 * A fourth case was written and deleted: "still sees a listening server when
 * the connect timeout is tiny", `listeningByUrl([url], 1)`. It failed, and it
 * was the assertion that was wrong, not the code — the in-child timer fires
 * before a loopback connect completes, so `timeoutMs` really does govern the
 * connect and 1 ms really is too short. Keeping it would have pinned a false
 * claim about loopback latency.
 */
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

async function listen(): Promise<string> {
	const server = createServer(() => {});
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || isJsonString(address)) {
		throw new Error("server did not bind a port");
	}
	return `http://127.0.0.1:${address.port}/`;
}

describe("loopback listen probe", () => {
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	it("reports a listening server as listening", async () => {
		const url = await listen();
		expect(listeningByUrl([url]).get(url)).toBe(true);
		expect(isLoopbackUrlListening(url)).toBe(true);
	});

	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	it("reports a closed port as not listening", async () => {
		const url = await listen();
		await new Promise<void>((resolve) => {
			servers.splice(0)[0]?.close(() => resolve());
		});
		expect(listeningByUrl([url]).get(url)).toBe(false);
	});

	it("judges each port separately in one batched pass", async () => {
		const live = await listen();
		const dead = await listen();
		await new Promise<void>((resolve) => {
			const server = servers.pop();
			if (server === undefined) {
				resolve();
				return;
			}
			server.close(() => resolve());
		});
		const map = listeningByUrl([live, dead]);
		expect(map.get(live)).toBe(true);
		expect(map.get(dead)).toBe(false);
	});
});
