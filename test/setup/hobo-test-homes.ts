/**
 * One directory per vitest run that holds every test file's throwaway
 * `HOBO_HOME` (`test/setup/isolate-hobo-home.ts`), removed when the run ends.
 *
 * A file's own `afterAll` cannot do it. Vitest runs none for a file whose every
 * test is skipped, or one that fails to load, and a timer, promise or child that
 * outlives its file can still write. Keeping every file's home until the run
 * ends, and never unsetting `HOBO_HOME`, means such a write lands in a directory
 * that exists, never in the developer's real `~/.hobo`, and is removed with the
 * rest.
 *
 * A `HOBO_HOME` the runner set is left alone, and then no root is made.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Names the run's root for the setup file; workers inherit it from this process. */
export const HOMES_ROOT_ENV = "HOBO_TEST_HOMES";

export default function setup(): (() => void) | undefined {
	if (process.env.HOBO_HOME) return undefined;
	const root = mkdtempSync(join(tmpdir(), "hobo-test-homes-"));
	process.env[HOMES_ROOT_ENV] = root;
	return () => {
		rmSync(root, { recursive: true, force: true });
	};
}
