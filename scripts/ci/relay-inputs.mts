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
