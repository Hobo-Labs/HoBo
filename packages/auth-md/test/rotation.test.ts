import { describe, expect, it } from "vitest";

import type {
	ClaimedAgentPrincipal,
	RotationPort,
	SensitiveRef,
} from "../src/index.js";
import {
	assertManagementAccess,
	createSensitive,
	discloseSensitive,
	isWorkClaimedByHumanWithRevokedAgent,
	parseInstant,
	parseRegistrationRef,
	planeSnapshot,
	requiresRotation,
	revokeAgentPrincipal,
	rotateAgentCredentials,
} from "../src/index.js";
import {
	binding,
	FAKE_KEY_MATERIAL,
	FAKE_ROTATED_KEY_MATERIAL,
	scopes,
} from "./fixtures.js";

const REGISTRATION_REF = "reg_01H8XABCDEF";

const claimedPrincipal = (
	overrides: Partial<ClaimedAgentPrincipal> = {},
): ClaimedAgentPrincipal => ({
	registrationRef: parseRegistrationRef(REGISTRATION_REF),
	phase: "human-bound",
	humanSubject: "human:ada",
	binding: binding(),
	preClaimScopes: scopes("repo:read"),
	postClaimScopes: scopes("repo:read"),
	claimedAt: parseInstant("2026-08-08T12:05:00.000Z"),
	rotateAfterInfrastructureClaim: true,
	rotationSatisfied: false,
	...overrides,
});

const keyMaterial = (): SensitiveRef<"agent-private-key"> =>
	createSensitive("agent-private-key", FAKE_KEY_MATERIAL, "handle-1");

const rotationPort = (): RotationPort & {
	readonly rotations: string[];
	readonly revocations: string[];
} => {
	const rotations: string[] = [];
	const revocations: string[] = [];
	return {
		id: "rotation:fixture",
		rotations,
		revocations,
		async rotate({ registrationRef, reason }) {
			rotations.push(`${registrationRef}:${reason}`);
			return {
				material: FAKE_ROTATED_KEY_MATERIAL,
				rotatedAt: "2026-08-08T12:10:00.000Z",
			};
		},
		async revoke({ registrationRef, reason }) {
			revocations.push(`${registrationRef}:${reason}`);
			return { revokedAt: "2026-08-08T12:20:00.000Z" };
		},
	};
};

describe("rotation forced by infrastructure claim", () => {
	it("requires rotation once infrastructure becomes owner-controlled", () => {
		expect(requiresRotation(claimedPrincipal(), "temporary")).toBe(false);
		expect(requiresRotation(claimedPrincipal(), "owner-controlled")).toBe(true);
	});

	it("refuses management access before rotation runs", () => {
		expect(() =>
			assertManagementAccess({
				principal: claimedPrincipal(),
				infrastructure: "owner-controlled",
			}),
		).toThrowError(
			expect.objectContaining({ code: "AUTHMD_ROTATION_REQUIRED" }),
		);
	});

	it("allows management access after rotation, and retires the old key", async () => {
		const port = rotationPort();
		const current = keyMaterial();

		const outcome = await rotateAgentCredentials({
			port,
			principal: claimedPrincipal(),
			currentKeyMaterial: current,
		});

		expect(port.rotations).toEqual([
			`${REGISTRATION_REF}:infrastructure-claim`,
		]);
		expect(outcome.rotation.previousKeyLocator).toBe(current.locator);
		expect(outcome.rotation.currentKeyLocator).not.toBe(current.locator);
		expect(discloseSensitive(outcome.keyMaterial)).toBe(
			FAKE_ROTATED_KEY_MATERIAL,
		);
		expect(() => discloseSensitive(current)).toThrow(
			"sensitive material is not available for this reference",
		);

		expect(() =>
			assertManagementAccess({
				principal: outcome.principal,
				infrastructure: "owner-controlled",
			}),
		).not.toThrow();
	});

	it("skips the requirement when the principal opted out", () => {
		expect(
			requiresRotation(
				claimedPrincipal({ rotateAfterInfrastructureClaim: false }),
				"owner-controlled",
			),
		).toBe(false);
	});
});

describe("revocation", () => {
	it("moves the principal to revoked and forgets the key", async () => {
		const port = rotationPort();
		const current = keyMaterial();

		const revoked = await revokeAgentPrincipal({
			port,
			principal: claimedPrincipal(),
			keyMaterial: current,
		});

		expect(revoked.phase).toBe("revoked");
		expect(port.revocations).toEqual([`${REGISTRATION_REF}:revocation`]);
		expect(() => discloseSensitive(current)).toThrow(
			"sensitive material is not available for this reference",
		);
	});

	it("refuses management access for a revoked principal", async () => {
		const port = rotationPort();
		const revoked = await revokeAgentPrincipal({
			port,
			principal: claimedPrincipal(),
		});

		expect(() =>
			assertManagementAccess({
				principal: revoked,
				infrastructure: "owner-controlled",
			}),
		).toThrowError(expect.objectContaining({ code: "AUTHMD_REVOKED" }));
	});

	it("refuses to revoke twice", async () => {
		const port = rotationPort();
		const revoked = await revokeAgentPrincipal({
			port,
			principal: claimedPrincipal(),
		});

		await expect(
			revokeAgentPrincipal({
				port,
				// A revoked principal has no legal `revoke` transition.
				principal: revoked as unknown as ClaimedAgentPrincipal,
			}),
		).rejects.toMatchObject({ code: "AUTHMD_REVOKED" });
	});
});

describe("the safe outcome: work claimed by the human, agent revoked", () => {
	it("is representable and grants the agent nothing", async () => {
		const port = rotationPort();
		const revoked = await revokeAgentPrincipal({
			port,
			principal: claimedPrincipal(),
		});
		const snapshot = planeSnapshot(
			"authenticated",
			"revoked",
			"owner-controlled",
		);

		expect(isWorkClaimedByHumanWithRevokedAgent(snapshot)).toBe(true);
		expect(() =>
			assertManagementAccess({
				principal: revoked,
				infrastructure: snapshot.infrastructure,
			}),
		).toThrowError(expect.objectContaining({ code: "AUTHMD_REVOKED" }));
	});
});
