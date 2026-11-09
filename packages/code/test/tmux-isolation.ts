// A tmux server of a test file's own, for test/isolate-tmux.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedTmux {
	/** TMUX_TMPDIR for the file's tests. */
	readonly socketDir: string;
	/** Kill the file's server, and remove its socket directory. */
	end(): void;
}

/**
 * Point `env` at a tmux socket directory of its own, clear TMUX (inside tmux
 * it names the developer's server and wins over TMUX_TMPDIR), and turn agent
 * seating off.
 */
export function isolateTmux(
	env: NodeJS.ProcessEnv = process.env,
): IsolatedTmux {
	const socketDir = mkdtempSync(join(tmpdir(), "hobo-code-tmux-"));
	// The one server the file's tests can start: tmux's default socket under
	// TMUX_TMPDIR. Named here, with PATH as it is now, so the end kills that
	// server whatever a test has since done to TMUX or TMUX_TMPDIR; read from
	// the environment at the end, a TMUX left set named the developer's.
	const socket = join(socketDir, `tmux-${process.getuid?.() ?? 0}`, "default");
	const path = env.PATH ?? "";
	env.TMUX_TMPDIR = socketDir;
	delete env.TMUX;
	env.HOBO_CODE_SEAT_AGENTS = "0";
	return {
		socketDir,
		end() {
			spawnSync("tmux", ["-S", socket, "kill-server"], {
				env: { PATH: path },
				stdio: "ignore",
			});
			rmSync(socketDir, { recursive: true, force: true });
		},
	};
}
