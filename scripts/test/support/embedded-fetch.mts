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
	timeoutMs: 20_000,
}).then(
	() => "finished",
	(error: Error & { code?: string }) => `rejected ${error.code ?? error.name}`,
);
await new Promise((resolve) => setTimeout(resolve, 300));
const left = existsSync(join(dir, "d")) ? readdirSync(join(dir, "d")) : [];
console.log(`parent handler calls: ${calls}`);
console.log(`download: ${outcome}`);
console.log(
	`left in the directory: ${left.length === 0 ? "nothing" : left.join(", ")}`,
);
