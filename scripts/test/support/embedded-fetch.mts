/**
 * Child of pins-interrupt.test.ts: a program that embeds `fetchVerified` and
 * has a SIGINT handler of its own. It starts a download that never finishes,
 * and reports what happened after the test signals it: how many times its own
 * handler ran, how the download ended and what is left in the directory.
 *
 * argv: <origin of a server that stalls /stall> <scratch directory>
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fetchVerified } from "../../lib/pins-fetch.ts";

const [origin = "", dir = ""] = process.argv.slice(2);
let calls = 0;
process.on("SIGINT", () => {
	calls += 1;
});

const dest = join(dir, "d", "tool");
const outcome = await fetchVerified(`${origin}/stall`, "a".repeat(64), dest, {
	allowLocal: true,
	// A fetch that ignores the signal fails here instead of hanging the test.
	timeoutMs: 20_000,
}).then(
	() => "finished",
	(error: Error & { code?: string }) => `rejected ${error.code ?? error.name}`,
);
// Leave room for a second delivery of the same signal before looking.
await new Promise((resolve) => setTimeout(resolve, 300));
const left = existsSync(join(dir, "d")) ? readdirSync(join(dir, "d")) : [];
console.log(`parent handler calls: ${calls}`);
console.log(`download: ${outcome}`);
console.log(
	`left in the directory: ${left.length === 0 ? "nothing" : left.join(", ")}`,
);
