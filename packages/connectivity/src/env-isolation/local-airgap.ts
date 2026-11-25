/**
 * Local-dev air-gap: pure local path never resolves/routes to remote-dev or production.
 * hobo dev must not auto-join remote overlays.
 */
import {
	ACCESS_EVENTS,
	type AccessEvent,
	createAccessEvent,
} from "./events.js";
import type { IsolationClass } from "./types.js";
import { parseIsolationClass } from "./types.js";

export type OverlayJoinRequest = Readonly<{
	/** Caller's isolation class (from control-plane membership). */
	callerClass: IsolationClass | null;
	/** Target overlay isolation class. */
	targetClass: IsolationClass;
	/** Explicit time-bound grant id if any. */
	crossEnvGrantId?: string;
	/** Whether a valid elevated/break-glass capability was presented. */
	hasElevatedCapability?: boolean;
}>;

export type OverlayJoinDecision = Readonly<{
	allowed: boolean;
	code: string;
	reason: string;
}>;

/**
 * Deny overlay join from pure local-dev to any remote class without explicit grant.
 */
export function evaluateOverlayJoin(
	request: OverlayJoinRequest,
): OverlayJoinDecision {
	const caller = request.callerClass;
	if (caller === null) {
		return {
			allowed: false,
			code: "env-missing",
			reason: "caller isolation class missing — fail closed",
		};
	}
	if (caller === request.targetClass) {
		if (caller === "local-dev") {
			// Local-dev has no remote overlay to join.
			return {
				allowed: false,
				code: "local-dev-no-remote-overlay",
				reason:
					"local-dev is air-gapped; no remote overlay join (use portless / loopback)",
			};
		}
		return {
			allowed: true,
			code: "same-env",
			reason: "same isolation class overlay join",
		};
	}
	// Cross-env: require grant or elevated capability
	if (request.crossEnvGrantId || request.hasElevatedCapability) {
		return {
			allowed: true,
			code: "explicit-grant",
			reason: "explicit time-bound grant or elevated capability",
		};
	}
	return {
		allowed: false,
		code: "cross-env-overlay-denied",
		reason: `overlay join from ${caller} to ${request.targetClass} denied without grant`,
	};
}

export function recordOverlayJoinDenied(input: {
	readonly tenant: string;
	readonly actor: string;
	readonly decision: OverlayJoinDecision;
	readonly events?: AccessEvent[];
}): AccessEvent {
	const evt = createAccessEvent({
		type: ACCESS_EVENTS.OverlayJoinDenied,
		tenant: input.tenant,
		actor: input.actor,
		data: {
			code: input.decision.code,
			reason: input.decision.reason,
		},
	});
	input.events?.push(evt);
	return evt;
}

/**
 * Local named endpoint resolution air-gap.
 * Reject backend URLs that look remote/prod when mode is local.
 */
export function assertLocalNamedEndpointBackend(input: {
	readonly mode: "local" | "overlay";
	readonly backendUrl: string;
	readonly resourceEnv?: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
	if (input.mode !== "local") {
		return { ok: true };
	}
	const env = parseIsolationClass(input.resourceEnv ?? "local-dev");
	if (env && env !== "local-dev") {
		return {
			ok: false,
			code: "local-airgap-env",
			reason: `local mode cannot bind resource with env ${env}`,
		};
	}
	const url = input.backendUrl.toLowerCase();
	// Reject obvious remote/prod hosts.
	const remoteHints = [
		".ts.net",
		"tailscale",
		"netbird",
		"prod.",
		"production.",
		".amazonaws.com",
		".azure.com",
		".googleapis.com",
	];
	for (const hint of remoteHints) {
		if (url.includes(hint)) {
			return {
				ok: false,
				code: "local-airgap-remote-backend",
				reason: `local mode refused remote-looking backend (${hint})`,
			};
		}
	}
	// Prefer loopback / localhost / .hobo.localhost
	const localOk =
		url.includes("127.0.0.1") ||
		url.includes("localhost") ||
		url.includes(".hobo.localhost") ||
		url.startsWith("http://0.0.0.0") ||
		url.startsWith("http://[::1]");
	if (!localOk && (url.startsWith("http://") || url.startsWith("https://"))) {
		// Relative or in-process backends without host are ok; host-based non-local fail.
		try {
			const u = new URL(url);
			if (
				u.hostname !== "localhost" &&
				u.hostname !== "127.0.0.1" &&
				u.hostname !== "::1" &&
				!u.hostname.endsWith(".hobo.localhost")
			) {
				return {
					ok: false,
					code: "local-airgap-non-loopback",
					reason: `local mode backend host ${u.hostname} is not loopback`,
				};
			}
		} catch {
			// non-URL backend keys allowed
		}
	}
	return { ok: true };
}

/** hobo dev must not ambiently join remote overlays. */
export function hoboDevOverlayJoinAllowed(): false {
	return false;
}
