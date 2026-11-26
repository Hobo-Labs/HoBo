// Per-call resource limits (CD_DEFAULTS: 128 MiB, 30 s, 10^9 fuel), metered
// deterministically by the host. Fuel and memory are charged only at
// host-observable points — invocation, every import call, every byte that
// crosses the boundary — so the same call against the same upstream trips
// at the same point on every run. Time is read from the injected clock at
// each boundary and backstopped by an injected timer for a guest that never
// yields.
import type { ComponentLimits } from "./manifest.js";

// public-contract: deterministic fuel prices charged by the host meter.
export const FUEL_COSTS = Object.freeze({
	/** Entering an exported function. */
	invoke: 1_000_000,
	/** Each host import call (log, send, authorized-fetch). */
	importCall: 5_000_000,
	/** Each byte crossing the boundary in either direction. */
	perByte: 100,
});

export type LimitKind = "fuel" | "memory" | "timeout";

/** Thrown inside a call when a limit trips; the host maps it to a refusal. */
export class LimitTrap extends Error {
	readonly kind: LimitKind;
	constructor(kind: LimitKind, message: string) {
		super(message);
		this.name = "LimitTrap";
		this.kind = kind;
	}
}

/** Injected timer so a hung guest is cut off without an ambient clock. */
export interface ComponentTimers {
	set(ms: number, fire: () => void): () => void;
}

export const systemTimers: ComponentTimers = Object.freeze({
	set(ms: number, fire: () => void): () => void {
		const handle = setTimeout(fire, ms);
		handle.unref?.();
		return () => clearTimeout(handle);
	},
});

/** One call's meter. Not shared between calls. */
export class CallMeter {
	readonly #limits: ComponentLimits;
	readonly #now: () => number;
	readonly #startedAt: number;
	#fuel = 0;
	#memory = 0;
	#peak = 0;
	#trap: LimitTrap | undefined;

	constructor(limits: ComponentLimits, now: () => number) {
		this.#limits = limits;
		this.#now = now;
		this.#startedAt = now();
	}

	get fuelUsed(): number {
		return this.#fuel;
	}
	get peakMemoryBytes(): number {
		return this.#peak;
	}
	get durationMs(): number {
		return Math.max(0, this.#now() - this.#startedAt);
	}
	get deadline(): number {
		return this.#startedAt + this.#limits.callTimeoutMs;
	}
	/** The first trap recorded for this call, if any. Sticky. */
	get trap(): LimitTrap | undefined {
		return this.#trap;
	}

	/** Charge fuel; trips at the exact charge that crosses the limit. */
	charge(fuel: number): void {
		this.#rethrow();
		this.#fuel += fuel;
		if (this.#fuel > this.#limits.fuel)
			this.#raise(
				new LimitTrap(
					"fuel",
					`fuel ${this.#fuel} exceeds the limit ${this.#limits.fuel}`,
				),
			);
	}

	/** Account bytes held for the rest of the call (bodies, outputs). */
	hold(bytes: number): void {
		this.#rethrow();
		this.#memory += bytes;
		this.#peak = Math.max(this.#peak, this.#memory);
		if (this.#memory > this.#limits.memoryBytes)
			this.#raise(
				new LimitTrap(
					"memory",
					`${this.#memory} bytes held exceeds the limit ${this.#limits.memoryBytes}`,
				),
			);
	}

	/** Check the deadline against the injected clock. */
	checkDeadline(): void {
		this.#rethrow();
		if (this.#now() > this.deadline)
			this.#raise(
				new LimitTrap(
					"timeout",
					`call exceeded ${this.#limits.callTimeoutMs} ms`,
				),
			);
	}

	/** Mark the call timed out (from the backstop timer). */
	expire(): LimitTrap {
		const trap = new LimitTrap(
			"timeout",
			`call exceeded ${this.#limits.callTimeoutMs} ms without yielding`,
		);
		this.#trap ??= trap;
		return this.#trap;
	}

	#raise(trap: LimitTrap): never {
		this.#trap ??= trap;
		throw this.#trap;
	}

	#rethrow(): void {
		if (this.#trap !== undefined) throw this.#trap;
	}
}
