import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A directory that lives as long as one vitest run, for fixtures shared across files. */
export const RUN_SCRATCH_ENV = "HOBO_CLI_TEST_SCRATCH";

export default function setup(): () => void {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cli-test-run-"));
	process.env[RUN_SCRATCH_ENV] = dir;
	return () => rmSync(dir, { recursive: true, force: true });
}
