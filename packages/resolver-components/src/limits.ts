import type { ComponentLimits } from "./manifest.js";

export const FUEL_COSTS = Object.freeze({
	invoke: 1_000_000,
	importCall: 5_000_000,
	perByte: 100,
});

export type LimitKind = "fuel" | "memory" | "timeout";

export class LimitTrap extends Error {
	readonly kind: LimitKind;
	constructor(kind: LimitKind, message: string) {
		super(message);
		this.name = "LimitTrap";
		this.kind = kind;
	}
}

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
	get trap(): LimitTrap | undefined {
		return this.#trap;
	}

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
