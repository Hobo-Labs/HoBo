/**
 * Which signals hobo-code's launcher (`hobo-code.mjs`) listens for, and
 * whether it passes them on to its child, by platform.
 *
 * Except on Windows the child runs in a session of its own, so neither a
 * signal sent to hobo-code nor the terminal's hangup reaches it: the launcher
 * listens for each signal that ends hobo-code and passes it on.
 *
 * On Windows the child shares the launcher's console and gets Ctrl-C and
 * Ctrl-Break itself. Passing a signal on there is TerminateProcess, a forced
 * kill: it races the child's own graceful handling, and no exit listener runs,
 * so a one-shot verb left its `hobo-yard-*` store. The launcher passes nothing
 * on there. It listens only so that Ctrl-C and Ctrl-Break do not end it
 * before its child, and waits.
 */
import { ENDING_SIGNALS } from "./ending-signals.mjs";

const CONSOLE = Object.freeze(["SIGINT", "SIGBREAK"]);

/**
 * @param {NodeJS.Platform} platform
 * @returns {{ readonly listen: readonly NodeJS.Signals[]; readonly forward: boolean }}
 */
export function launcherSignals(platform) {
	return platform === "win32"
		? { listen: CONSOLE, forward: false }
		: { listen: ENDING_SIGNALS, forward: true };
}

/**
 * Pass `signal` on to the child: to its process group, which it leads in a
 * session of its own, so that what it starts without detaching (the `--pi`
 * TUI, `tmux attach`, the `ssh` of `session serve --host`) gets the signal
 * too. (A `/hobo` command runs in the child itself, or, with
 * `HOBO_CODE_HOBO_BIN`, as one more process in the group.)
 * Sent to the child alone, the signal orphaned them wherever the child had no
 * handler for it. When the group cannot be signalled (ESRCH: the child leads
 * none, or is gone; or any other failure), the child gets it alone.
 *
 * This runs in the launcher's signal handler, so it never throws: a throw
 * there ended the launcher before its child, and passed the signal on to no
 * one.
 *
 * @param {{ readonly pid?: number | undefined; kill(signal: NodeJS.Signals): unknown }} child
 * @param {NodeJS.Signals} signal
 * @param {(pid: number, signal: NodeJS.Signals) => unknown} [kill]
 */
export function forwardSignal(
	child,
	signal,
	kill = (pid, sent) => process.kill(pid, sent),
) {
	if (child.pid === undefined) return;
	try {
		kill(-child.pid, signal);
		return;
	} catch {
		// The group could not be signalled: the child alone, below.
	}
	try {
		child.kill(signal);
	} catch {
		// Nothing is left to pass the signal on to.
	}
}
