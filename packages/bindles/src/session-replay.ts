import type { ProviderAnnotation } from "./types.js";

export const SESSION_REPLAY_OPTION = "session-replay" as const;

export type SessionReplayBindleConfig = Readonly<{
	enabled?: boolean;
	sampleRate?: number;
}>;

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

export function defaultAppKitSessionReplayAnnotation(): ProviderAnnotation {
	return sessionReplay({ enabled: true });
}
