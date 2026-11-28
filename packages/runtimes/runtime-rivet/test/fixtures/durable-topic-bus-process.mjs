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
let commitBarrier;
process.on("message", async (message) => {
	if (!message || typeof message.id !== "number") return;
	try {
		let result;
		if (message.kind === "advance") {
			await host.controls.advanceMs(message.delta);
			result = null;
		} else if (message.kind === "arm-commit-barrier") {
			if (commitBarrier) throw new Error("commit barrier already armed");
			commitBarrier = await host.controls.holdNextMutation("before-commit");
			void commitBarrier.reached
				.then(() => {
					if (process.connected) process.send?.({ kind: "commit-reached" });
				})
				.catch(() => {});
			result = null;
		} else if (message.kind === "release-commit-barrier") {
			if (!commitBarrier) throw new Error("commit barrier is not armed");
			await commitBarrier.release();
			commitBarrier = undefined;
			result = null;
		} else if (message.kind === "block-receipt") {
			await host.controls.blockNextReceiptLookup(message.reason);
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
