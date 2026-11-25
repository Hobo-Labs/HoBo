import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RUN_SCRATCH_ENV = "HOBO_CLI_TEST_SCRATCH";

export default function setup(): () => void {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cli-test-run-"));
	process.env[RUN_SCRATCH_ENV] = dir;
	return () => rmSync(dir, { recursive: true, force: true });
}
