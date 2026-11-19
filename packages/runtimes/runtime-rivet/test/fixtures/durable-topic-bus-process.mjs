/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this test worker checks its IPC request identifier before dispatch. */
import { createSqliteBusConformanceHostWithStorage } from "./durable-topic-bus-conformance.ts";

const [directory, rawClock] = process.argv.slice(2);
const clock = Number(rawClock);
if (!directory || !Number.isSafeInteger(clock))
	throw new Error("invalid worker arguments");
const host = await createSqliteBusConformanceHostWithStorage({
	directory,
	clock,
});
const ports = new Map();
process.on("message", async (message) => {
	if (!message || typeof message.id !== "number") return;
	try {
		let result;
		if (message.kind === "advance") {
			await host.controls.advanceMs(message.delta);
			result = null;
		} else if (message.kind === "fetch") {
			if (message.tenant !== "tenant-a" && message.tenant !== "tenant-b")
				throw new Error("invalid worker tenant");
			let port = ports.get(message.tenant);
			if (!port) {
				port = await host.open(message.tenant);
				ports.set(message.tenant, port);
			}
			const response = await port.fetch(message.path, {
				method: "POST",
				headers: message.headers,
				body: message.body,
			});
			result = { status: response.status, body: await response.text() };
		} else throw new Error("invalid worker request");
		process.send?.({ id: message.id, result });
	} catch {
		process.send?.({ id: message.id, error: "worker request failed" });
	}
});
process.send?.({ kind: "ready" });
