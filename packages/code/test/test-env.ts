import { isolateTmux } from "./tmux-isolation.js";

/**
 * The environment for a process a test starts with an environment of its own.
 *
 * test/isolate-tmux.ts points this test file at a tmux server of its own
 * (TMUX_TMPDIR) and turns agent seating off, in this process's environment.
 * An `env` built from nothing leaves both out, so whatever the spawned
 * process ran tmux for reached the developer's server. This adds them, keeps
 * a TMUX_TMPDIR the caller names, and drops TMUX.
 */
export function testEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// Lazily isolate when the package setupFiles did not run (a root
	// test:file/single-file run): point this process at its own tmux
	// server instead of failing every testEnv user.
	if (process.env.TMUX_TMPDIR === undefined) isolateTmux();
	const socketDir = process.env.TMUX_TMPDIR;
	if (socketDir === undefined) {
		throw new Error("test/isolate-tmux.ts has not run: TMUX_TMPDIR is unset");
	}
	return Object.fromEntries(
		Object.entries({
			TMUX_TMPDIR: socketDir,
			HOBO_CODE_SEAT_AGENTS: "0",
			...env,
		}).filter(([name]) => name !== "TMUX"),
	);
}
