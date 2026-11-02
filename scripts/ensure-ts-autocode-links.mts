import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const trainingMarker = join(
	root,
	"external/ts-autocode/packages/training/node_modules/@agentv/core/package.json",
);
const groundingMarker = join(
	root,
	"node_modules/ts-autocode-grounding/package.json",
);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function linked(): Promise<boolean> {
	return (await exists(trainingMarker)) && (await exists(groundingMarker));
}

if (!(await linked())) {
	await exec(
		"pnpm",
		[
			"install",
			"--filter",
			"ts-autocode-grounding...",
			"--filter",
			"ts-autocode-training...",
			"--config.confirmModulesPurge=false",
			"--prefer-offline",
		],
		{ cwd: root, env: process.env },
	);
	if (!(await linked())) {
		throw new Error(
			"ts-autocode sibling packages are not linked (ts-autocode-grounding, ts-autocode-training); run pnpm install after pins:fetch",
		);
	}
}
