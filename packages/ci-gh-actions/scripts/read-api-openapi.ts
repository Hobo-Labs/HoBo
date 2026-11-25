import { readFile, writeFile } from "node:fs/promises";
import { readApiOpenApi } from "../src/read-api.js";

const path = new URL("../schema/read-api.openapi.json", import.meta.url);
const generated = readApiOpenApi();
if (process.argv.includes("--check")) {
	if ((await readFile(path, "utf8").catch(() => "")) !== generated)
		throw new Error(
			"schema/read-api.openapi.json is stale; run node --import tsx scripts/read-api-openapi.ts",
		);
} else await writeFile(path, generated);
