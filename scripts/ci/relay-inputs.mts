import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { importerClosure, parseLockfile } from "../lib/pnpm-lockfile.mts";

export const RELAY_PACKAGE_DIR = "packages/ci-vercel";

export function relayInputDirs(lockfileText: string): readonly string[] {
	return [...importerClosure(parseLockfile(lockfileText), [RELAY_PACKAGE_DIR])]
		.filter((dir) => dir !== "." && dir !== "")
		.sort();
}

export function touchesRelay(
	changed: readonly string[],
	inputDirs: readonly string[],
): boolean {
	return changed.some((file) =>
		inputDirs.some((dir) => file === dir || file.startsWith(`${dir}/`)),
	);
}

export function writeRelayInputs(lockfilePath: string, outPath: string): void {
	writeFileSync(
		outPath,
		`${JSON.stringify(relayInputDirs(readFileSync(lockfilePath, "utf8")))}\n`,
	);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	const [lockfilePath = "pnpm-lock.yaml", outPath = "relay-inputs.json"] =
		process.argv.slice(2);
	writeRelayInputs(lockfilePath, outPath);
}
