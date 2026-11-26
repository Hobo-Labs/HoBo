/**
 * Gate-executed example: dual-fixture record → store → summarize.
 */
import { proveRecordStorePlay } from "../src/session-replay-contracts.js";

const result = await proveRecordStorePlay();
if (!result.ok) {
	console.error("session-replay example failed", result);
	process.exit(1);
}
console.log(
	JSON.stringify(
		{
			ok: true,
			package: result.package,
			sessionId: result.sessionId,
			chunkCount: result.chunkCount,
			events: result.eventTypes,
		},
		null,
		2,
	),
);
