import { componentize } from "@bytecodealliance/componentize-js";
import { mkdirSync, writeFileSync } from "node:fs";

const [sourcePath, witPath, outputPath, cachePath] = process.argv.slice(2);
if (!sourcePath || !witPath || !outputPath || !cachePath) {
	throw new Error("source, WIT, output, and cache paths are required");
}

mkdirSync(cachePath, { recursive: true });
const env =
	process.platform === "win32"
		? { LOCALAPPDATA: cachePath }
		: { XDG_CACHE_HOME: cachePath };
const result = await componentize({
	sourcePath,
	witPath,
	worldName: "proxy",
	disableFeatures: ["stdio"],
	env,
});
writeFileSync(outputPath, result.component);
