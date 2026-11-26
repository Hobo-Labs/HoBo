import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { YardDeploySource } from "./yard-deploy-source-contract.js";

export type { YardDeploySource } from "./yard-deploy-source-contract.js";
export { yardDeployByTarget } from "./yard-deploy-source-contract.js";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEPLOY_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.deploy\.ts$/u;

/** Server/prerender only — do not import from browser controller entry. */
export async function loadYardDeploySources(
	repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly YardDeploySource[]> {
	const yardsRoot = path.join(repoRoot, "examples", "try-site", "yards");
	const entries = await readdir(yardsRoot);
	const sources: YardDeploySource[] = [];
	for (const name of entries.sort()) {
		const match = DEPLOY_FILE.exec(name);
		if (!match) continue;
		const targetId = match[1]!;
		const sourcePath = `examples/try-site/yards/${name}`;
		const source = await readFile(path.join(yardsRoot, name), "utf8");
		sources.push({
			targetId,
			sourcePath,
			source: source.endsWith("\n") ? source : `${source}\n`,
		});
	}
	return sources;
}
