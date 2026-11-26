/**
 * Broker target resolution for `hobo up` / `hobo claim`.
 *
 * Order (locked):
 *   1. CLI `--broker` / `--broker-uri` (aliases)
 *   2. Env `HOBO_BROKER` / `HOBO_BROKER_URI`
 *   3. Persisted profile default under HOBO_HOME
 *   4. Embedded local broker
 */

import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString } from "./json.js";

export type BrokerTargetKind = "local" | "remote";
export type BrokerDeployMode = "auth" | "anonymous";

export interface LocalBrokerTarget {
	readonly kind: "local";
}

export interface RemoteBrokerTarget {
	readonly kind: "remote";
	readonly uri: string;
	readonly mode: BrokerDeployMode;
	readonly source: "flag" | "env" | "profile";
}

export type BrokerTarget = LocalBrokerTarget | RemoteBrokerTarget;

export interface BrokerTargetFlags {
	readonly broker?: string | null;
	readonly brokerUri?: string | null;
	readonly anonymous?: boolean;
	readonly temporary?: boolean;
}

/**
 * Canonical URI from flag aliases: prefer --broker, then --broker-uri.
 */
export function resolveBrokerUriFromFlags(
	flags: BrokerTargetFlags,
): string | null {
	const a =
		isJsonString(flags.broker) && flags.broker.trim().length > 0
			? flags.broker.trim()
			: null;
	const b =
		isJsonString(flags.brokerUri) && flags.brokerUri.trim().length > 0
			? flags.brokerUri.trim()
			: null;
	return a ?? b;
}

export function wantsAnonymousMode(flags: BrokerTargetFlags): boolean {
	return flags.anonymous === true || flags.temporary === true;
}

export function resolveBrokerTarget(input: {
	readonly flags: BrokerTargetFlags;
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome: string;
}): BrokerTarget {
	const env = input.env ?? process.env;
	const anonymous = wantsAnonymousMode(input.flags);
	const mode: BrokerDeployMode = anonymous ? "anonymous" : "auth";

	const fromFlag = resolveBrokerUriFromFlags(input.flags);
	if (fromFlag !== null) {
		return {
			kind: "remote",
			uri: normalizeBrokerUri(fromFlag),
			mode,
			source: "flag",
		};
	}

	const fromEnvRaw = env.HOBO_BROKER ?? env.HOBO_BROKER_URI;
	if (isJsonString(fromEnvRaw) && fromEnvRaw.trim().length > 0) {
		return {
			kind: "remote",
			uri: normalizeBrokerUri(fromEnvRaw.trim()),
			mode,
			source: "env",
		};
	}

	const profile = loadHoboProfile(input.hoboHome);
	const fromProfile =
		profile?.defaultBrokerUri ?? profile?.session?.brokerUri ?? null;
	if (fromProfile !== null && fromProfile.trim().length > 0) {
		return {
			kind: "remote",
			uri: normalizeBrokerUri(fromProfile.trim()),
			// Profile implies authenticated association unless anonymous flags force mode.
			mode,
			source: "profile",
		};
	}

	// Anonymous without a remote URI is meaningless — stay local.
	return { kind: "local" };
}

export function normalizeBrokerUri(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new TypeError(
			`invalid broker URI "${raw}" (expected absolute http(s) URL)`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError(
			`broker URI must use http or https (got ${url.protocol})`,
		);
	}
	return url.toString().replace(/\/+$/, "");
}
