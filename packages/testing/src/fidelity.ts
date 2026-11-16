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
 * - `simulated` — an HTTP-shaped resource whose collected entrypoint resolved
 *   to a real fetch handler and is served on a real loopback listener. Real
 *   application code executes and real HTTP crosses the wire; it is not the
 *   deployed wasm component on the deployed host, so it is not `real`.
 * - `camp-only` — kinds this lane structurally cannot exercise (`container`,
 *   `wasm-component`): they need a container engine or wasm execution.
 * - `mocked` — everything else. A handle and a binding locator exist; no
 *   engine runs behind them. Labelling these `simulated` because an in-memory
 *   map *could* back them would be the overclaim; nothing in `DeployedGraph`
 *   exposes such a store, so nothing simulated is observable.
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

/** Kinds the in-process lane structurally cannot exercise. */
export const CAMP_ONLY_KINDS: readonly string[] = Object.freeze([
	"container",
	"wasm-component",
]);

/** Kinds whose collected entrypoint can be served over loopback HTTP. */
export const HTTP_SERVED_KINDS: readonly string[] = Object.freeze([
	"api",
	"service",
	"ui",
	"web",
]);

export function isHttpServedKind(kind: string): boolean {
	return HTTP_SERVED_KINDS.includes(kind);
}

/**
 * Fidelity of one handle in the in-process lane. `served` is true only when a
 * real fetch handler was resolved *and* a listener was opened for it.
 */
export function inProcessFidelity(kind: string, served: boolean): Fidelity {
	if (CAMP_ONLY_KINDS.includes(kind)) return "camp-only";
	if (served && isHttpServedKind(kind)) return "simulated";
	return "mocked";
}

export function emptyFidelityCounts(): Record<Fidelity, number> {
	return { real: 0, simulated: 0, mocked: 0, "camp-only": 0 };
}
