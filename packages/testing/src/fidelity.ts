/**
 * ADR-0042 fidelity attestation for harness handles.
 *
 * `runtime-local` does not execute real `.wasm` bytes today. The in-process
 * lane therefore boots the *collected graph* with local binding resolution and
 * simulated resources — so every handle it hands back must say what it really
 * is. The vocabulary is ADR-0042's: `real | simulated | mocked | camp-only`.
 *
 * The labelling rule is deliberately conservative and keyed to what is
 * *observable through this package's surface*, not to what could in principle
 * be simulated:
 *
 * - `simulated` — a served HTTP entrypoint or an accessible local service port
 *   backed by the in-memory implementation. Neither is a deployed provider.
 * - `camp-only` — kinds this lane structurally cannot exercise (`container`,
 *   `wasm-component`): they need a container engine or wasm execution.
 * - `mocked` — a caller-supplied mock or a placeholder with no engine behind
 *   it. Unsupported kinds do not become simulated just because a possible
 *   implementation exists elsewhere.
 * - `real` — never produced by the in-process lane. It is reserved for the
 *   `ephemeral-camp` lane and for the day `runtime-local` executes real
 *   component bytes.
 */

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
