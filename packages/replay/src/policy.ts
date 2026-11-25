import { defaultPrivacyPolicy, type PrivacyPolicy } from "./types.js";

// public-contract: OpenFeature / env keys for progressive recording control.
export const REPLAY_FLAG_KEY = "hobo.session-replay" as const;
// public-contract: stable exported contract literal
export const REPLAY_ENV_KILL = "HOBO_REPLAY" as const;

export type RecordingDecision = Readonly<{
	enabled: boolean;
	reason:
		| "local-default-on"
		| "env-kill"
		| "flag-off"
		| "flag-on"
		| "production-default-off"
		| "sampled-in"
		| "sampled-out"
		| "effect-isolated";
	sampleRate: number;
	privacy: PrivacyPolicy;
}>;

export type RecordingPolicyInput = Readonly<{
	env?: Readonly<Record<string, string | undefined>>;
	flagEnabled?: boolean;
	sampleRate?: number;
	sampleUnit?: number;
	isolationClass?: string;
	effectIsolated?: boolean;
	privacy?: PrivacyPolicy;
}>;

export function evaluateRecordingPolicy(
	input: RecordingPolicyInput = {},
): RecordingDecision {
	const privacy = input.privacy ?? defaultPrivacyPolicy();
	const env = input.env ?? {};
	const kill = env[REPLAY_ENV_KILL];
	if (kill === "0" || kill === "false" || kill === "off") {
		return Object.freeze({
			enabled: false,
			reason: "env-kill",
			sampleRate: 0,
			privacy,
		});
	}
	if (input.effectIsolated) {
		return Object.freeze({
			enabled: false,
			reason: "effect-isolated",
			sampleRate: 0,
			privacy,
		});
	}
	if (input.flagEnabled === false) {
		return Object.freeze({
			enabled: false,
			reason: "flag-off",
			sampleRate: 0,
			privacy,
		});
	}
	const isolation = input.isolationClass ?? env.HOBO_ENV ?? "local-dev";
	const isProdLike =
		isolation === "production" ||
		isolation === "staging" ||
		env.NODE_ENV === "production";

	if (input.flagEnabled === true) {
		const rate = clamp01(input.sampleRate ?? 1);
		const unit = input.sampleUnit ?? 0;
		const inSample = unit < rate;
		return Object.freeze({
			enabled: inSample,
			reason: inSample ? "flag-on" : "sampled-out",
			sampleRate: rate,
			privacy,
		});
	}

	if (isProdLike) {
		const rate = clamp01(input.sampleRate ?? 0);
		if (rate <= 0) {
			return Object.freeze({
				enabled: false,
				reason: "production-default-off",
				sampleRate: 0,
				privacy,
			});
		}
		const unit = input.sampleUnit ?? 0;
		const inSample = unit < rate;
		return Object.freeze({
			enabled: inSample,
			reason: inSample ? "sampled-in" : "sampled-out",
			sampleRate: rate,
			privacy,
		});
	}

	return Object.freeze({
		enabled: true,
		reason: "local-default-on",
		sampleRate: 1,
		privacy,
	});
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}
