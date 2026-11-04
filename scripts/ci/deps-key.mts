import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { depsContextPaths, depsKeyForRoot } from "../lib/deps-key.mts";

const root = process.cwd();
const platform = `linux/${process.arch === "x64" ? "amd64" : process.arch}`;
const toolchainIndex = process.argv.indexOf("--toolchain");
const toolchain =
	toolchainIndex === -1 ? undefined : process.argv[toolchainIndex + 1];
if (toolchainIndex !== -1 && !toolchain)
	throw new Error("--toolchain requires a version");
const stageIndex = process.argv.indexOf("--stage");
if (stageIndex !== -1) {
	const destination = process.argv[stageIndex + 1];
	if (!destination) throw new Error("--stage requires a directory");
	for (const path of depsContextPaths(root)) {
		const target = join(destination, path);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(root, path), target);
	}
}
process.stdout.write(`${depsKeyForRoot(root, platform, toolchain)}\n`);
