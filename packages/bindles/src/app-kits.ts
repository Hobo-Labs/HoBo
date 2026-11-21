/**
 * App Kits — Bindle-declared application surfaces (ADR-0137 language).
 *
 * Prefer **Kit** / **App Kit** over calling these "membrane types" at the Bindle
 * authoring layer. The WIT/WASM *membrane* (ADR-0069 / wRPC) remains the
 * low-level portability contract; Kits are the app-facing composition of ports
 * into entrypoint-bearing surfaces that hosts can serve and Session Replay can
 * attach to by default.
 */
import type { ResourceKind } from "./types.js";

/**
 * Application Kit kinds — surfaces that host app entrypoints or interactive
 * runtime behavior. Session Replay is default-supplied for every Kit.
 */
export const APP_KIT_KINDS = Object.freeze([
	"api",
	"web",
	"service",
	"ui",
	"websocket",
	"job",
	"wasm-component",
] as const satisfies readonly ResourceKind[]);

export type AppKitKind = (typeof APP_KIT_KINDS)[number];

/**
 * HTTP-servable Kits (fetch handlers on local Yard / Camp hosts).
 * Subset of APP_KIT_KINDS that participate in listServableEntrypoints.
 */
export const HTTP_APP_KIT_KINDS = Object.freeze([
	"api",
	"web",
	"service",
	"ui",
] as const satisfies readonly AppKitKind[]);

export type HttpAppKitKind = (typeof HTTP_APP_KIT_KINDS)[number];

/** Port / infrastructure Kits — not entrypoint hosts; no default Session Replay. */
export const INFRA_KIT_KINDS = Object.freeze([
	"kv",
	"bucket",
	"queue",
	"topic",
	"secret",
	"data",
	"schedule",
	"project",
	"external",
	"container",
	"flag",
	"auth",
	"crypto",
	"notify",
	"guardrail",
	"experiment",
	"rollout",
] as const satisfies readonly ResourceKind[]);

export function isAppKitKind(kind: string): kind is AppKitKind {
	// SAFETY: assertion required at this I/O or test boundary.
	return (APP_KIT_KINDS as readonly string[]).includes(kind);
}

export function isHttpAppKitKind(kind: string): kind is HttpAppKitKind {
	// SAFETY: assertion required at this I/O or test boundary.
	return (HTTP_APP_KIT_KINDS as readonly string[]).includes(kind);
}

/** Display label for docs / doctor surfaces. */
export function appKitLabel(kind: AppKitKind): string {
	switch (kind) {
		case "api":
			return "API Kit";
		case "web":
			return "Web Kit";
		case "service":
			return "Service Kit";
		case "ui":
			return "UI Kit";
		case "websocket":
			return "Realtime Kit";
		case "job":
			return "Job Kit";
		case "wasm-component":
			return "Component Kit";
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}
