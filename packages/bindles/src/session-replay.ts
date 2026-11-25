/**
 * Bindle-side Session Replay annotation helpers (ADR-0137).
 * Runtime wrap/inject lives in `@hobo/replay`; this module only declares intent.
 *
 * Default-supplied on every **App Kit** (api, web, service, ui, websocket, job,
 * wasm-component) — not only Web Kits. Opt out per Kit with
 * `.with(sessionReplay({ enabled: false }))`.
 */
import type { ProviderAnnotation } from "./types.js";

// public-contract: annotation option auto-attached to every App Kit resource.
export const SESSION_REPLAY_OPTION = "session-replay" as const;

export type SessionReplayBindleConfig = Readonly<{
	/** Default true on App Kits. Set false to opt a Kit out. */
	enabled?: boolean;
	sampleRate?: number;
}>;

/**
 * Explicit Session Replay annotation for `.with(sessionReplay(...))`.
 * Prefer accepting the App Kit default; use `{ enabled: false }` to disable.
 */
export function sessionReplay(
	config: SessionReplayBindleConfig = {},
): ProviderAnnotation {
	return Object.freeze({
		provider: "hobo",
		option: SESSION_REPLAY_OPTION,
		config: Object.freeze({
			enabled: config.enabled !== false,
			defaultSupply: "kit-local-on",
			...(config.sampleRate !== undefined
				? { sampleRate: config.sampleRate }
				: undefined),
		}),
	});
}

export function isSessionReplayAnnotation(
	annotation: ProviderAnnotation,
): boolean {
	return annotation.option === SESSION_REPLAY_OPTION;
}

/** Default annotation auto-attached when constructing any App Kit resource. */
export function defaultAppKitSessionReplayAnnotation(): ProviderAnnotation {
	return sessionReplay({ enabled: true });
}
