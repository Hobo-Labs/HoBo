/**
 * Holding the signals that end hobo-code while it has something open that
 * the signal's default action would leave open.
 *
 * `session serve --host <machine>` opens a Station authorization, then runs
 * ssh, and closes the authorization when the forward ends. Node acts on a
 * signal only while something listens for it; with no listener the default
 * action ends the process where it stands. A signal that came before the
 * forward's listeners existed (while the authorization was being opened, or
 * while ssh was being started) ended hobo-code with the authorization open.
 *
 * A hold listens for every ending signal from `hold()` until `release()`. It
 * records the first, and calls whatever reacts to it meanwhile (`whileHeld`):
 * the one holding it decides what the signal ends, and when.
 */
import { constants } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ENDING_SIGNALS } from "../bin/ending-signals.mjs";

/** The part of a process a hold listens on; `process` is one. */
export interface SignalSource {
	on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
	off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
}

export interface EndingSignalHold {
	/** Start listening for the ending signals; once held, nothing more. */
	hold(): void;
	/** Whether the signals are held. */
	readonly held: boolean;
	/** The first ending signal that came while they were held. */
	readonly first: NodeJS.Signals | undefined;
	/** Call `react` on each ending signal from now on; the result stops it. */
	whileHeld(react: (signal: NodeJS.Signals) => void): () => void;
	/** Stop listening: an ending signal has its default action again. */
	release(): void;
}

export function endingSignalHold(
	proc: SignalSource = process,
): EndingSignalHold {
	let held = false;
	let first: NodeJS.Signals | undefined;
	const reactions = new Set<(signal: NodeJS.Signals) => void>();
	const onSignal = (signal: NodeJS.Signals): void => {
		first ??= signal;
		for (const react of reactions) react(signal);
	};
	return {
		hold() {
			if (held) return;
			held = true;
			for (const signal of ENDING_SIGNALS) proc.on(signal, onSignal);
		},
		get held() {
			return held;
		},
		get first() {
			return first;
		},
		whileHeld(react) {
			reactions.add(react);
			return () => {
				reactions.delete(react);
			};
		},
		release() {
			reactions.clear();
			if (!held) return;
			held = false;
			for (const signal of ENDING_SIGNALS) proc.off(signal, onSignal);
		},
	};
}

/**
 * Let an ending signal sent while the process was busy reach its listeners.
 * Node hands a signal to them when the event loop next polls, and two turns
 * of `setImmediate` pass through at least one poll wherever they start.
 */
export async function letSignalsArrive(): Promise<void> {
	await nextTurn();
	await nextTurn();
}

/** A process's status when signal `signal` ended it: 128+n, as a shell reports it. */
export function signalStatus(signal: NodeJS.Signals): number {
	return 128 + constants.signals[signal];
}
