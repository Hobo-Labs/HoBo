import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cacheDir = process.env.MAIN_GATE_PLAN_CACHE_DIR?.trim();
const githubOutput = process.env.GITHUB_OUTPUT?.trim();

if (!cacheDir || !githubOutput) {
	console.error(
		"load-main-gate-plan-cache: cache dir or GITHUB_OUTPUT missing",
	);
	process.exit(1);
}

const payloadPath = join(cacheDir, "outputs.env");
let text: string;
try {
	text = readFileSync(payloadPath, "utf8");
} catch {
	console.error(`load-main-gate-plan-cache: no cache at ${payloadPath}`);
	process.exit(1);
}
appendFileSync(githubOutput, text);
console.error(`load-main-gate-plan-cache: restored from ${payloadPath}`);
