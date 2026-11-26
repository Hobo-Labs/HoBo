/**
 * Policy-gated view access + PAM-style elevated capability for sensitive sessions.
 * Cross-Station / cross-isolation fails closed without federation or elevated grant.
 */
import type { IsolationClass, SessionRecord } from "./types.js";

export type AccessDecision = Readonly<{
	allowed: boolean;
	reason:
		| "same-station"
		| "elevated-capability"
		| "federation-grant"
		| "station-mismatch"
		| "isolation-mismatch"
		| "production-requires-elevation"
		| "erased";
	audit: Readonly<{
		action: "replay.view" | "replay.export";
		sessionId: string;
		viewerStationId: string;
		elevated: boolean;
	}>;
}>;

export type AccessRequest = Readonly<{
	session: SessionRecord;
	viewerStationId: string;
	viewerIsolationClass?: IsolationClass;
	/** Short-lived Station/Broker capability for PAM break-glass. */
	elevatedCapability?: Readonly<{
		scope: "replay.view" | "replay.export";
		stationId: string;
		expiresAt: string;
		now?: string;
	}>;
	/** Explicit Junction federation grant. */
	federationGrant?: Readonly<{
		fromStationId: string;
		toStationId: string;
		scope: "replay.view";
	}>;
	action?: "replay.view" | "replay.export";
}>;

export function evaluateReplayAccess(req: AccessRequest): AccessDecision {
	const action = req.action ?? "replay.view";
	const audit = Object.freeze({
		action,
		sessionId: req.session.id,
		viewerStationId: req.viewerStationId,
		elevated: Boolean(req.elevatedCapability),
	});

	if (req.session.status === "erased") {
		return Object.freeze({
			allowed: false,
			reason: "erased",
			audit,
		});
	}

	if (req.session.correlation.stationId === req.viewerStationId) {
		const isolation = req.session.correlation.isolationClass;
		const needsElevation =
			isolation === "production" || isolation === "staging";
		if (needsElevation) {
			const cap = req.elevatedCapability;
			const now = cap?.now ?? new Date().toISOString();
			if (
				cap &&
				cap.scope === action &&
				cap.stationId === req.viewerStationId &&
				cap.expiresAt > now
			) {
				return Object.freeze({
					allowed: true,
					reason: "elevated-capability",
					audit: Object.freeze({ ...audit, elevated: true }),
				});
			}
			return Object.freeze({
				allowed: false,
				reason: "production-requires-elevation",
				audit,
			});
		}
		return Object.freeze({
			allowed: true,
			reason: "same-station",
			audit,
		});
	}

	if (
		req.federationGrant &&
		req.federationGrant.fromStationId === req.session.correlation.stationId &&
		req.federationGrant.toStationId === req.viewerStationId &&
		req.federationGrant.scope === "replay.view"
	) {
		return Object.freeze({
			allowed: true,
			reason: "federation-grant",
			audit,
		});
	}

	if (
		req.viewerIsolationClass &&
		req.viewerIsolationClass !== req.session.correlation.isolationClass
	) {
		return Object.freeze({
			allowed: false,
			reason: "isolation-mismatch",
			audit,
		});
	}

	return Object.freeze({
		allowed: false,
		reason: "station-mismatch",
		audit,
	});
}
