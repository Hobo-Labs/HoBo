import { PinsError } from "./pins.ts";

export const NET_TIMEOUT_ENV = "HOBO_PINS_NET_TIMEOUT_MS";
export const DEFAULT_NET_TIMEOUT_MS = 120_000;
export const MAX_NET_TIMEOUT_MS = 600_000;

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
