import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadToolchainLock } from "../src/index.js";
import {
	assertGeneratedMatches,
	writeGeneratedBindings,
} from "../src/wit-gen.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = join(PACKAGE_ROOT, "wit-lock.json");

async function main() {
	await loadToolchainLock(LOCK_PATH);

	if (process.argv.includes("--check")) {
		const result = await assertGeneratedMatches();
		console.log(`wit:check ok (${result.checked} generated declaration files)`);
		return;
	}

	const files = await writeGeneratedBindings();
	console.log(`wit:gen wrote ${files.length} declaration files`);
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
