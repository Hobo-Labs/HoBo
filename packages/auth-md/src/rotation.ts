/**
 * Rotation, revocation, and re-registration.
 *
 * When infrastructure becomes owner-controlled, the credential the agent
 * minted while the infrastructure was temporary is no longer a credential the
 * new owner ever consented to. `rotateAfterInfrastructureClaim` therefore
 * gates management access: until rotation runs, management calls fail closed
 * with AUTHMD_ROTATION_REQUIRED. Revocation is terminal for a registration;
 * the agent comes back only as a new registration, never as the old one.
 */
import type { ClaimedAgentPrincipal } from "./claim.js";
import { authMdError } from "./errors.js";
import type { MaterialLocator, SensitiveRef } from "./redaction.js";
import { createSensitive, forgetSensitive } from "./redaction.js";
import type {
	AgentRegistration,
	RegisterAnonymousAgentOptions,
} from "./registration.js";
import { materialHandle, registerAnonymousAgent } from "./registration.js";
import type { InfrastructurePhase } from "./state-machines.js";
import { advanceAgentPrincipal } from "./state-machines.js";
import type { Instant, RegistrationRef, SessionBinding } from "./types.js";
import { instantFrom, parseInstant } from "./types.js";

export type RotationReason = "infrastructure-claim" | "revocation" | "operator";

/** Injected credential-lifecycle port; no cryptography is performed here. */
export interface RotationPort {
	readonly id: string;
	rotate(input: {
		readonly registrationRef: RegistrationRef;
		readonly binding: SessionBinding;
		readonly reason: RotationReason;
	}): Promise<{ readonly material: string; readonly rotatedAt?: string }>;
	revoke(input: {
		readonly registrationRef: RegistrationRef;
		readonly reason: RotationReason;
	}): Promise<{ readonly revokedAt?: string }>;
}

// domain-view: parsed derived type; wire form is KeyRotationRecord in data-models/auth_md.proto.
export interface KeyRotation {
	readonly registrationRef: RegistrationRef;
	readonly previousKeyLocator: MaterialLocator;
	readonly currentKeyLocator: MaterialLocator;
	readonly rotatedAt: Instant;
	readonly reason: RotationReason;
}

export interface RotationOutcome {
	readonly rotation: KeyRotation;
	readonly keyMaterial: SensitiveRef<"agent-private-key">;
	readonly principal: ClaimedAgentPrincipal;
}

export interface RevokedAgentPrincipal {
	readonly registrationRef: RegistrationRef;
	readonly phase: "revoked";
	readonly revokedAt: Instant;
	readonly reason: RotationReason;
	readonly binding: SessionBinding;
}

export type AgentPrincipal = ClaimedAgentPrincipal | RevokedAgentPrincipal;

export function requiresRotation(
	principal: ClaimedAgentPrincipal,
	infrastructure: InfrastructurePhase,
): boolean {
	return (
		infrastructure === "owner-controlled" &&
		principal.rotateAfterInfrastructureClaim &&
		!principal.rotationSatisfied
	);
}

/**
 * The gate every management operation must pass. Note what it does not do:
 * an owner-controlled infrastructure phase never implies the agent is allowed
 * anything — it is precisely what makes rotation mandatory.
 */
export function assertManagementAccess(input: {
	readonly principal: AgentPrincipal;
	readonly infrastructure: InfrastructurePhase;
}): void {
	if (input.principal.phase === "revoked") {
		throw authMdError(
			"AUTHMD_REVOKED",
			"the agent principal is revoked; management access is refused",
			{ registrationRef: input.principal.registrationRef },
		);
	}
	if (requiresRotation(input.principal, input.infrastructure)) {
		throw authMdError(
			"AUTHMD_ROTATION_REQUIRED",
			"infrastructure is owner-controlled; rotate agent credentials before continuing management access",
			{ registrationRef: input.principal.registrationRef },
		);
	}
}

export async function rotateAgentCredentials(input: {
	readonly port: RotationPort;
	readonly principal: ClaimedAgentPrincipal;
	readonly currentKeyMaterial: SensitiveRef<"agent-private-key">;
	readonly reason?: RotationReason;
	readonly now?: () => Date;
}): Promise<RotationOutcome> {
	if (input.principal.phase !== "human-bound") {
		throw authMdError(
			"AUTHMD_REVOKED",
			"only a human-bound principal can rotate credentials",
			{ registrationRef: input.principal.registrationRef },
		);
	}

	const reason = input.reason ?? "infrastructure-claim";
	const result = await input.port.rotate({
		registrationRef: input.principal.registrationRef,
		binding: input.principal.binding,
		reason,
	});
	if (result.material.length === 0) {
		throw authMdError(
			"AUTHMD_ROTATION_REQUIRED",
			"rotation port returned no replacement key material",
			{ registrationRef: input.principal.registrationRef },
		);
	}

	const rotatedAt =
		result.rotatedAt === undefined
			? instantFrom((input.now ?? (() => new Date()))())
			: parseInstant(result.rotatedAt, "rotatedAt");

	const keyMaterial = createSensitive(
		"agent-private-key",
		result.material,
		materialHandle(input.principal.registrationRef, rotatedAt, reason),
	);
	// The superseded key stops being disclosable the moment it is superseded.
	forgetSensitive(input.currentKeyMaterial);

	return {
		rotation: Object.freeze({
			registrationRef: input.principal.registrationRef,
			previousKeyLocator: input.currentKeyMaterial.locator,
			currentKeyLocator: keyMaterial.locator,
			rotatedAt,
			reason,
		}),
		keyMaterial,
		principal: Object.freeze({
			...input.principal,
			rotationSatisfied: true,
		}),
	};
}

export async function revokeAgentPrincipal(input: {
	readonly port: RotationPort;
	readonly principal: ClaimedAgentPrincipal | AgentRegistration;
	readonly keyMaterial?: SensitiveRef<"agent-private-key">;
	readonly reason?: RotationReason;
	readonly now?: () => Date;
}): Promise<RevokedAgentPrincipal> {
	const reason = input.reason ?? "revocation";
	// Legal from both pre-claim and human-bound; illegal from revoked.
	advanceAgentPrincipal(input.principal.phase, "revoke");

	const result = await input.port.revoke({
		registrationRef: input.principal.registrationRef,
		reason,
	});
	if (input.keyMaterial !== undefined) forgetSensitive(input.keyMaterial);

	return Object.freeze({
		registrationRef: input.principal.registrationRef,
		phase: "revoked" as const,
		revokedAt:
			result.revokedAt === undefined
				? instantFrom((input.now ?? (() => new Date()))())
				: parseInstant(result.revokedAt, "revokedAt"),
		reason,
		binding: input.principal.binding,
	});
}

/**
 * Re-registration after revocation mints a *new* registration. The revoked
 * reference is never reanimated, so anything that trusted it stays untrusting.
 */
export async function reRegisterAfterRevocation(input: {
	readonly revoked: RevokedAgentPrincipal;
	readonly registration: RegisterAnonymousAgentOptions;
}): Promise<AgentRegistration> {
	advanceAgentPrincipal(input.revoked.phase, "reRegister");
	const registration = await registerAnonymousAgent(input.registration);
	if (registration.registrationRef === input.revoked.registrationRef) {
		throw authMdError(
			"AUTHMD_REVOKED",
			"re-registration reused the revoked registration reference",
			{ registrationRef: input.revoked.registrationRef },
		);
	}
	return registration;
}
