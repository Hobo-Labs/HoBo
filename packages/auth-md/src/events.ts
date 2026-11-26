/**
 * The `authmd.*` event family and its projection.
 *
 * Commands (register, initiate claim, poll claim, rotate, revoke) are handled
 * by the agent-principal actor — one actor instance per `registrationRef`,
 * which is the stream key. The actor emits these events to the event store;
 * it never mutates a read model directly. `foldAgentPrincipalEvents` is the
 * materialized view over that stream, and `AgentPrincipalView` doubles as the
 * snapshot persisted in the read store for current-state reads. Every event
 * is refs-only, so replaying the stream can never resurrect key material.
 */
import type { ClaimedAgentPrincipal, ClaimInitiation } from "./claim.js";
import type { AgentRegistration } from "./registration.js";
import type { KeyRotation, RevokedAgentPrincipal } from "./rotation.js";
import type { AgentPrincipalPhase } from "./state-machines.js";
import type { Instant, RegistrationRef, Scope } from "./types.js";

export const AUTHMD_EVENT_TYPES = [
	"authmd.AgentRegistered",
	"authmd.ClaimInitiated",
	"authmd.PrincipalClaimed",
	"authmd.ScopeWideningDenied",
	"authmd.CredentialsRotated",
	"authmd.PrincipalRevoked",
] as const;

export type AgentPrincipalEventType = (typeof AUTHMD_EVENT_TYPES)[number];

// domain-view: parsed derived type; wire form is AgentPrincipalEventRecord in data-models/auth_md.proto.
export interface AgentPrincipalEvent {
	readonly type: AgentPrincipalEventType;
	readonly registrationRef: RegistrationRef;
	readonly occurredAt: Instant;
	readonly phase: AgentPrincipalPhase;
	readonly scopes: readonly Scope[];
	readonly detail?: string;
}

export function agentRegisteredEvent(
	registration: AgentRegistration,
): AgentPrincipalEvent {
	return Object.freeze({
		type: "authmd.AgentRegistered" as const,
		registrationRef: registration.registrationRef,
		occurredAt: registration.issuedAt,
		phase: "pre-claim" as const,
		scopes: registration.preClaimScopes,
	});
}

export function claimInitiatedEvent(
	initiation: ClaimInitiation,
	occurredAt: Instant,
): AgentPrincipalEvent {
	return Object.freeze({
		type: "authmd.ClaimInitiated" as const,
		registrationRef: initiation.registrationRef,
		occurredAt,
		phase: "pre-claim" as const,
		scopes: initiation.requestedPostClaimScopes,
	});
}

export function principalClaimedEvent(
	principal: ClaimedAgentPrincipal,
): AgentPrincipalEvent {
	return Object.freeze({
		type: "authmd.PrincipalClaimed" as const,
		registrationRef: principal.registrationRef,
		occurredAt: principal.claimedAt,
		phase: "human-bound" as const,
		scopes: principal.postClaimScopes,
		detail: principal.humanSubject,
	});
}

export function scopeWideningDeniedEvent(input: {
	readonly registrationRef: RegistrationRef;
	readonly occurredAt: Instant;
	readonly phase: AgentPrincipalPhase;
	readonly attemptedScopes: readonly Scope[];
}): AgentPrincipalEvent {
	return Object.freeze({
		type: "authmd.ScopeWideningDenied" as const,
		registrationRef: input.registrationRef,
		occurredAt: input.occurredAt,
		phase: input.phase,
		scopes: input.attemptedScopes,
	});
}

export function credentialsRotatedEvent(
	rotation: KeyRotation,
	scopes: readonly Scope[],
): AgentPrincipalEvent {
	return Object.freeze({
		type: "authmd.CredentialsRotated" as const,
		registrationRef: rotation.registrationRef,
		occurredAt: rotation.rotatedAt,
		phase: "human-bound" as const,
		scopes,
		detail: rotation.reason,
	});
}

export function principalRevokedEvent(
	revoked: RevokedAgentPrincipal,
): AgentPrincipalEvent {
	return Object.freeze({
		type: "authmd.PrincipalRevoked" as const,
		registrationRef: revoked.registrationRef,
		occurredAt: revoked.revokedAt,
		phase: "revoked" as const,
		scopes: [],
		detail: revoked.reason,
	});
}

/** Materialized view / read-store snapshot for one agent principal stream. */
export interface AgentPrincipalView {
	readonly registrationRef: RegistrationRef | undefined;
	readonly phase: AgentPrincipalPhase;
	readonly scopes: readonly Scope[];
	readonly claimedBy: string | undefined;
	readonly rotationSatisfied: boolean;
	readonly lastEventAt: Instant | undefined;
	readonly deniedWidenings: number;
}

export const EMPTY_AGENT_PRINCIPAL_VIEW: AgentPrincipalView = Object.freeze({
	registrationRef: undefined,
	phase: "unregistered" as const,
	scopes: Object.freeze([]),
	claimedBy: undefined,
	rotationSatisfied: false,
	lastEventAt: undefined,
	deniedWidenings: 0,
});

export function foldAgentPrincipalEvents(
	events: readonly AgentPrincipalEvent[],
	snapshot: AgentPrincipalView = EMPTY_AGENT_PRINCIPAL_VIEW,
): AgentPrincipalView {
	let view = snapshot;
	for (const event of events) {
		const base = {
			...view,
			registrationRef: event.registrationRef,
			lastEventAt: event.occurredAt,
		};
		switch (event.type) {
			case "authmd.AgentRegistered":
				view = {
					...base,
					phase: "pre-claim",
					scopes: event.scopes,
					rotationSatisfied: false,
				};
				break;
			case "authmd.ClaimInitiated":
				view = base;
				break;
			case "authmd.PrincipalClaimed":
				view = {
					...base,
					phase: "human-bound",
					scopes: event.scopes,
					claimedBy: event.detail,
				};
				break;
			case "authmd.ScopeWideningDenied":
				view = { ...base, deniedWidenings: view.deniedWidenings + 1 };
				break;
			case "authmd.CredentialsRotated":
				view = { ...base, rotationSatisfied: true };
				break;
			case "authmd.PrincipalRevoked":
				view = {
					...base,
					phase: "revoked",
					scopes: Object.freeze([]),
					rotationSatisfied: false,
				};
				break;
		}
	}
	return view;
}
