/**
 * The watchdog the interactive shell runs its forward's ssh under.
 *
 * Usage: node ssh-watchdog.mjs <lease-deadline-ms> <command> [args...]
 *
 * The shell starts ssh detached, so that the launcher's signal to hobo-code's
 * process group cannot end it before the shell has closed the authorization
 * in order. Detached, ssh would outlive a shell that never got to quit: a
 * crash, or SIGKILL, which no handler sees. This watchdog ties ssh's life to
 * the shell's anyway. Its stdin is a pipe the shell's process holds, and that
 * pipe ends however the process ends, SIGKILL included: then the watchdog
 * ends ssh. It ends ssh at the authorization's lease too (the deadline, in
 * milliseconds since the epoch), even if the shell's own timer cannot run.
 *
 * ssh runs in a process group of its own, which the watchdog signals whole:
 * SIGTERM, then SIGKILL after a grace. A signal the shell sends the watchdog
 * (its stop) is passed on the same way. The watchdog ends as ssh did: with
 * ssh's status, or by ssh's signal.
 */
import { spawn } from "node:child_process";
import { ENDING_SIGNALS } from "./ending-signals.mjs";

// Process groups are POSIX: on Windows there is no group to signal whole,
// and kill(-pid) is invalid. The shell spawns ssh directly there; refuse
// to run rather than pretend the lifetime tie exists.
if (process.platform === "win32") {
	process.stderr.write("ssh-watchdog: not supported on Windows\n");
	process.exit(1);
}

/** How long ssh's group gets to end on a signal before it is killed. */
const GRACE_MS = 3_000;

const [deadlineArg = "", command = "", ...args] = process.argv.slice(2);
const deadline = Number(deadlineArg);

const ssh = spawn(command, args, {
	stdio: ["ignore", "ignore", "inherit"],
	detached: true,
});

let hardStop;
let ended = false;
/** Signal ssh's process group, and kill it if it has not ended in GRACE_MS. */
function end(signal) {
	if (ended || ssh.pid === undefined) return;
	try {
		process.kill(-ssh.pid, signal);
	} catch {
		// The group has gone already.
	}
	hardStop ??= setTimeout(() => {
		try {
			process.kill(-ssh.pid, "SIGKILL");
		} catch {
			// The group has gone already.
		}
	}, GRACE_MS);
}

const relay = (signal) => end(signal);
for (const signal of ENDING_SIGNALS) process.on(signal, relay);

// The shell's process holds the other end of this pipe: its end, however the
// process ends, is the end of the shell.
process.stdin.on("end", () => end("SIGTERM"));
process.stdin.on("close", () => end("SIGTERM"));
process.stdin.on("error", () => end("SIGTERM"));
process.stdin.resume();

const lease = Number.isFinite(deadline)
	? setTimeout(
			() => end("SIGTERM"),
			Math.min(Math.max(deadline - Date.now(), 0), 2_147_483_647),
		)
	: undefined;

ssh.once("error", () => {
	ended = true;
	process.exit(127);
});
ssh.once("exit", (code, signal) => {
	ended = true;
	if (lease !== undefined) clearTimeout(lease);
	if (hardStop !== undefined) clearTimeout(hardStop);
	process.stdin.destroy();
	if (signal === null) {
		process.exit(code ?? 1);
		return;
	}
	// End as ssh did, by its signal: nothing here may catch it now.
	for (const each of ENDING_SIGNALS) process.removeListener(each, relay);
	process.kill(process.pid, signal);
});
