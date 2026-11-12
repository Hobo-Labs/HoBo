// Shared pieces of the reference adapters: an injected clock, a context, and
// typed refusals. Reference adapters are small, in-memory and deterministic;
// each takes a `mutant` switch that breaks exactly one port property so the
// kit can show the suite catching it.
import { createHash } from "node:crypto";
import type { CdOutcomeLike, CdReasonLike } from "@hobo/conformance";

export type RefCtx = Readonly<{
	tenant: string;
	principal: string;
	now: () => number;
	signal?: AbortSignal;
}>;

export class ManualClock {
	#now: number;
	constructor(startMs = 1_000_000) {
		this.#now = startMs;
	}
	now = (): number => this.#now;
	advance(ms: number): void {
		this.#now += ms;
	}
}

export function refCtx(clock: ManualClock = new ManualClock(), principal = "operator:conformance"): RefCtx {
	return { tenant: "conformance", principal, now: clock.now };
}

export function reason(code: string, message: string, remediation: string): CdReasonLike {
	return { code, message, remediation };
}

export function refuse<T>(code: string, message: string, remediation: string): CdOutcomeLike<T> {
	return { ok: false, reasons: [reason(code, message, remediation)] };
}

export function ok<T>(value: T): CdOutcomeLike<T> {
	return { ok: true, value };
}

export function sha256(text: string | Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function abortedRefusal<T>(): CdOutcomeLike<T> {
	return refuse("aborted", "the operation was aborted before any effect", "retry with a live signal");
}
