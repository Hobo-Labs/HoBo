/**
 * `hobo-code session serve --host <machine>`: forward a resident session
 * browser over ssh, under the Station authorization the CLI opened for it.
 *
 * The entry point holds the ending signals from before that authorization is
 * opened (the `signals` dep, `src/signal-hold.ts`) until it has closed the
 * authorization, once this returns. Here a signal ends the forward, not the
 * process: ssh is stopped (SIGKILL after 5 s if it holds on), and the status
 * is 128+n. A signal that came before the forward began, while the
 * authorization was being opened, means it never begins: no browser address,
 * no ssh.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DevMachine } from "./dev-machines.js";
import { preferNamedEndpoint } from "./occupancy-endpoints.js";
import {
	authorizationLeaseDelay,
	remoteSessionServeSshArgs,
} from "./resident-session-cli.js";
import {
	type EndingSignalHold,
	letSignalsArrive,
	signalStatus,
} from "./signal-hold.js";

export interface SessionForward {
	readonly machine: DevMachine;
	readonly port: number;
	readonly identityAgent: string;
	readonly authorizationSessionId?: string;
	readonly authorizationExpiresAt?: string;
	readonly auditTypes?: readonly string[];
}

/** What the forward needs of the ssh it starts; a ChildProcess is one. */
export interface StartedSsh {
	kill(signal: NodeJS.Signals): void;
	once(event: "error", listener: (error: Error) => void): void;
	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
}

/** The watchdog the shell also runs its forward's ssh under. */
const SSH_WATCHDOG = fileURLToPath(
	new URL("../bin/ssh-watchdog.mjs", import.meta.url),
);

/**
 * Run ssh detached under the watchdog, as the shell's forward does: in
 * hobo-code's own process group the launcher's group signal ended ssh in
 * parallel with hobo-code's handler, and the status hinged on which
 * thread Node handed first. Detached under the watchdog, ssh outlives
 * neither the signal (passed on by stopSsh) nor this process (the
 * watchdog's stdin pipe ends with it) nor the lease. Windows has no
 * process groups, so ssh runs directly there.
 */
const startSshDetached =
	(deadlineMs: number) =>
	(args: readonly string[]): StartedSsh =>
		process.platform === "win32"
			? spawn("ssh", [...args], { stdio: "inherit" })
			: spawn(
					process.execPath,
					[SSH_WATCHDOG, String(deadlineMs), "ssh", ...args],
					{ stdio: ["pipe", "inherit", "inherit"], detached: true },
				);

/** How long ssh gets to end on the signal it was passed before it is killed. */
const SSH_STOP_GRACE_MS = 5_000;

/** What the forward says where the browser is, before it starts ssh. */
export function forwardBanner(forward: SessionForward): string {
	return `browser: ${preferNamedEndpoint(`http://127.0.0.1:${forward.port}/`, "sessions")}\nremote: ${forward.machine.id} via Station-authorized SSH forwarding (${forward.authorizationSessionId ?? "authorized"}; expires ${forward.authorizationExpiresAt ?? "unknown"}; ${(forward.auditTypes ?? []).join(", ") || "audited"})\nssh authentication: Station authorization gates ${forward.identityAgent}; no key or token is copied\n`;
}

/**
 * Run the forward until ssh ends, the authorization's lease runs out (124),
 * or an ending signal comes (128+n); the result is hobo-code's status.
 */
export async function forwardResidentSessions(
	forward: SessionForward,
	signals: EndingSignalHold,
	io: {
		readonly stdout?: NodeJS.WritableStream;
		readonly startSsh?: (args: readonly string[]) => StartedSsh;
	} = {},
): Promise<number> {
	signals.hold();
	// One sent while the authorization was being opened, when the process was
	// busy, may not have reached the hold yet.
	await letSignalsArrive();
	if (signals.first !== undefined) return signalStatus(signals.first);
	const { machine, port } = forward;
	(io.stdout ?? process.stdout).write(forwardBanner(forward));
	const leaseMs = authorizationLeaseDelay(forward.authorizationExpiresAt ?? "");
	const args = remoteSessionServeSshArgs(machine, port, forward.identityAgent);
	return new Promise<number>((resolve) => {
		let child: StartedSsh | undefined;
		let expired = false;
		let stoppedBy: NodeJS.Signals | undefined;
		let hardStop: NodeJS.Timeout | undefined;
		let ended = false;
		const stopSsh = (signal: NodeJS.Signals): void => {
			if (ended || child === undefined) return;
			child.kill(signal);
			hardStop ??= setTimeout(() => child?.kill("SIGKILL"), SSH_STOP_GRACE_MS);
		};
		// Reacting before ssh starts: a signal that came while it was being
		// started is handled once it has, and stops it.
		const stopReacting = signals.whileHeld((signal) => {
			stoppedBy ??= signal;
			stopSsh(signal);
		});
		child = (
			io.startSsh ??
			startSshDetached(Date.parse(forward.authorizationExpiresAt ?? ""))
		)(args);
		const expiration = setTimeout(() => {
			expired = true;
			stopSsh("SIGTERM");
		}, leaseMs);
		const finish = (code: number): void => {
			ended = true;
			clearTimeout(expiration);
			if (hardStop) clearTimeout(hardStop);
			// ssh is gone: a signal from here on stops nothing, and arms no
			// SIGKILL. The signals stay held, only recorded, until the caller
			// has closed the authorization and releases them; released here, a
			// second signal ended hobo-code before pam.SessionEnded was written.
			stopReacting();
			resolve(code);
		};
		child.once("error", () => finish(1));
		child.once("exit", (code, signal) => {
			// Node can hand hobo-code ssh's exit before the signal that
			// caused it reaches its listener here: the two reach different
			// threads. Let that signal arrive before the status is decided,
			// or it was ssh's (1).
			ended = true;
			void letSignalsArrive().then(() =>
				finish(
					expired
						? 124
						: stoppedBy !== undefined
							? signalStatus(stoppedBy)
							: signal === "SIGINT"
								? 130
								: (code ?? 1),
				),
			);
		});
	});
}
