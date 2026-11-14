/**
 * Elevated capabilities are JWT-SVIDs minted and verified through the one
 * SVID implementation (`@hobo/identity`, here its test double): no shared
 * secret, no development default, nothing accepted without a verifier.
 */
import { describe, expect, it } from "vitest";
import {
	ELEVATED_ACCESS_SCOPE_PORT,
	type ElevatedSvidClaims,
	mintElevatedAccessCapability,
	verifyElevatedAccessCapability,
} from "../src/index.js";
import { createTestElevatedIssuer } from "./support/elevated-issuer.js";

const NOW = "2026-06-01T12:00:00.000Z";

async function minted() {
	const issuer = createTestElevatedIssuer();
	const result = await mintElevatedAccessCapability(
		{
			subject: "user:alice",
			isolationClass: "production",
			issuedBy: "cp-admin",
			priorAuthnClass: "development",
			ttlSeconds: 600,
			evidence: { kind: "dual-approval", ref: "approval-1" },
			issuer,
			now: NOW,
		},
		{ tenant: "acme" },
	);
	return {
		issuer,
		trust: { issuer: issuer.issuerUrl, verify: issuer.verify },
		...result,
	};
}

describe("elevated access capabilities", () => {
	it("mints through the issuer and verifies through the trust", async () => {
		const { token, capability, event, trust } = await minted();
		expect(capability).toMatchObject({
			subject: "user:alice",
			audience: "production-access",
			priorAuthnClass: "development",
			expiresAt: "2026-06-01T12:10:00.000Z",
		});
		expect(event.data).toMatchObject({ capabilityId: capability.id });
		expect(JSON.stringify(event)).not.toContain(token);

		const verified = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "production-access",
			expectedIsolationClass: "production",
			trust,
			now: "2026-06-01T12:05:00.000Z",
		});
		expect(verified).toMatchObject({
			ok: true,
			capability: {
				id: capability.id,
				subject: "spiffe://yard/user:alice",
				issuedAt: NOW,
				expiresAt: capability.expiresAt,
				obligations: capability.obligations,
			},
			tokenClaims: { aud: ["production-access", "env:production"] },
		});
	});

	it("refuses every token when no trust is configured", async () => {
		const { token } = await minted();
		const refused = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "production-access",
			expectedIsolationClass: "production",
			trust: undefined,
			now: NOW,
		});
		expect(refused).toMatchObject({
			ok: false,
			code: "elevated-unverifiable",
		});
	});

	it("refuses a token from another issuer key, and an expired one", async () => {
		const { token, issuer } = await minted();
		const stranger = createTestElevatedIssuer(issuer.issuerUrl);
		const forged = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "production-access",
			expectedIsolationClass: "production",
			trust: { issuer: stranger.issuerUrl, verify: stranger.verify },
			now: NOW,
		});
		expect(forged).toMatchObject({ ok: false, code: "elevated-invalid" });

		const expired = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "production-access",
			expectedIsolationClass: "production",
			trust: { issuer: issuer.issuerUrl, verify: issuer.verify },
			now: "2026-06-01T13:00:00.000Z",
		});
		expect(expired).toMatchObject({ ok: false, code: "elevated-expired" });
	});

	it("refuses a token for another environment", async () => {
		const { token, trust } = await minted();
		const refused = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "production-access",
			expectedIsolationClass: "staging",
			trust,
			now: NOW,
		});
		expect(refused).toMatchObject({ ok: false, code: "elevated-wrong-env" });
	});

	it("refuses an SVID from the same issuer that is not an elevated capability", async () => {
		const issuer = createTestElevatedIssuer();
		const iat = Math.floor(Date.parse(NOW) / 1000);
		const workload: ElevatedSvidClaims = {
			sub: "spiffe://yard/workload",
			aud: ["production-access", "env:production"],
			tenant: "acme",
			parentPrincipal: { kind: "workload", id: "w1" },
			codeVersion: { digest: "sha256:00", version: "1" },
			scope: [{ port: "storage", resource: "bucket", verbs: ["read"] }],
			iat,
			nbf: iat,
			exp: iat + 600,
		};
		const refused = await verifyElevatedAccessCapability({
			token: await issuer.signJwtSvid(workload),
			expectedAudience: "production-access",
			expectedIsolationClass: "production",
			trust: { issuer: issuer.issuerUrl, verify: issuer.verify },
			now: NOW,
		});
		expect(refused).toMatchObject({ ok: false, code: "elevated-invalid" });
		expect(ELEVATED_ACCESS_SCOPE_PORT).toBe("elevated-access");
	});
});
