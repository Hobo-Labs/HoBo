
import type { Fidelity } from "./types.js";

export const FIDELITIES: readonly Fidelity[] = Object.freeze([
	"real",
	"simulated",
	"mocked",
	"camp-only",
]);

export const CAMP_ONLY_KINDS: readonly string[] = Object.freeze([
	"container",
	"wasm-component",
]);

export const HTTP_SERVED_KINDS: readonly string[] = Object.freeze([
	"api",
	"service",
	"ui",
	"web",
]);

export function isHttpServedKind(kind: string): boolean {
	return HTTP_SERVED_KINDS.includes(kind);
}

export function inProcessFidelity(kind: string, served: boolean): Fidelity {
	if (CAMP_ONLY_KINDS.includes(kind)) return "camp-only";
	if (served && isHttpServedKind(kind)) return "simulated";
	return "mocked";
}

export function emptyFidelityCounts() {
	return { real: 0, simulated: 0, mocked: 0, "camp-only": 0 };
}
