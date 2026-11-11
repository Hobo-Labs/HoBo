import { setTimeout as delay } from "node:timers/promises";

const REAPER_UNREACHABLE = "Failed to connect to Reaper";
const ATTEMPTS = 4;
const BETWEEN_ATTEMPTS_MS = 3_000;

/**
 * Starts a Testcontainers container, starting again when the shared reaper
 * could not be reached.
 *
 * Each test file runs in its own process, and Testcontainers shares one
 * reaper container between processes. A reaper whose last client has
 * disconnected lingers for about ten seconds, still listed as running but no
 * longer accepting connections. A file that starts a container in that window
 * finds it, fails to connect within the library's fixed four seconds, and
 * throws. Once the stale reaper has exited, a start creates a new one.
 *
 * `build` is called for every attempt because a container definition is
 * started once.
 */
export async function startContainer<Started>(
	build: () => { start(): Promise<Started> },
): Promise<Started> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await build().start();
		} catch (error) {
			const reaperUnreachable =
				error instanceof Error && error.message.includes(REAPER_UNREACHABLE);
			if (!reaperUnreachable || attempt === ATTEMPTS) throw error;
			await delay(BETWEEN_ATTEMPTS_MS);
		}
	}
}
