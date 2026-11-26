/**
 * How long the pin code waits on the network before it gives up.
 *
 * One bound, HOBO_PINS_NET_TIMEOUT_MS (default 120 s, at most 600 s), applies
 * to every git call that touches the network (the whole call) and to every
 * download (each wait: for the response, and for the next bytes of the body).
 * Running out of it is a NET_TIMEOUT that names the call; nothing is staged,
 * written or kept.
 *
 * Erasable TypeScript with node builtins only.
 */
import { PinsError } from "./pins.ts";

export const NET_TIMEOUT_ENV = "HOBO_PINS_NET_TIMEOUT_MS";
export const DEFAULT_NET_TIMEOUT_MS = 120_000;
export const MAX_NET_TIMEOUT_MS = 600_000;

/** The bound for this run: the variable when set (a positive integer <= 600000), else 120 s. */
export function netTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[NET_TIMEOUT_ENV];
	if (raw === undefined || raw === "") return DEFAULT_NET_TIMEOUT_MS;
	const ms = /^[1-9][0-9]{0,5}$/u.test(raw) ? Number(raw) : Number.NaN;
	if (!(ms <= MAX_NET_TIMEOUT_MS)) {
		throw new PinsError(
			"USAGE",
			`${NET_TIMEOUT_ENV}=${raw.slice(0, 40)} must be a whole number of milliseconds from 1 to ${MAX_NET_TIMEOUT_MS}`,
		);
	}
	return ms;
}

export function netTimeout(what: string, ms: number): PinsError {
	return new PinsError(
		"NET_TIMEOUT",
		`${what} got no answer within ${ms} ms; nothing was changed. A slow link can raise ${NET_TIMEOUT_ENV} (at most ${MAX_NET_TIMEOUT_MS})`,
	);
}

/**
 * An abort that fires when nothing has happened for `ms`: `touch()` it on
 * every sign of life (a response, a chunk). `fired` tells a timeout from the
 * other reasons a request is aborted.
 */
export class Watchdog {
	readonly #controller = new AbortController();
	#timer: ReturnType<typeof setTimeout> | undefined;
	fired = false;
	readonly ms: number;

	constructor(ms: number) {
		this.ms = ms;
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	touch(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.fired = true;
			this.#controller.abort();
		}, this.ms);
	}

	stop(): void {
		clearTimeout(this.#timer);
	}
}
