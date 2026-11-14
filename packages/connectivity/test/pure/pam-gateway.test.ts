import { describe, expect, it } from "vitest";

import {
	applyEnvIsolationAclHints,
	createNativePamGateway,
	createSessionBrokerKeys,
	createTeleportPamGateway,
	mintElevatedAccessCapability,
	mintSessionToken,
	renderEnvIsolationTailscaleAcl,
	verifySessionToken,
} from "../../src/index.js";
import { createTestElevatedIssuer } from "../support/elevated-issuer.js";

describe("PAM gateway complete secretless broker", () => {
	it("native gateway mints, verifies, renews, ends sessions with yard audit drain", async () => {
		const gw = createNativePamGateway({ isolationClass: "development" });
		await gw.start({
			stationId: "s1",
			tenant: "acme",
			isolationClass: "development",
			trustDomain: "yard.local",
		});
		const session = await gw.brokerSession({
			subject: "user:dev",
			target: { id: "ssh:box", kind: "ssh", isolationClass: "development" },
			preferSecretless: true,
		});
		expect(session.protocol).toBe("hobo-svid");
		const v = gw.verifyLocalSession(session.sessionToken);
		expect(v.ok).toBe(true);
		await gw.renewSession(session.sessionId);
		await gw.endSession(session.sessionId);
		expect(gw.auditEvents.map((e) => e.type)).toEqual(
			expect.arrayContaining([
				"pam.GatewayStarted",
				"pam.SessionStarted",
				"pam.SessionRenewed",
				"pam.SessionEnded",
			]),
		);
		expect(gw.yardDrainCount).toBeGreaterThan(0);
		await gw.stop();
	});

	it("production rejects dummy elevated tokens", async () => {
		const issuer = createTestElevatedIssuer();
		const gw = createTeleportPamGateway({
			isolationClass: "production",
			elevatedTrust: { issuer: issuer.issuerUrl, verify: issuer.verify },
		});
		await gw.start({
			stationId: "sp",
			tenant: "acme",
			isolationClass: "production",
			trustDomain: "t",
		});
		await expect(
			gw.brokerSession({
				subject: "u",
				target: "ssh:x",
				preferSecretless: true,
				elevatedToken: "dummy-elevated",
			}),
		).rejects.toBeTruthy();
		const elev = await mintElevatedAccessCapability({
			subject: "u",
			isolationClass: "production",
			issuedBy: "cp",
			evidence: { kind: "break-glass", ref: "bg1" },
			issuer,
		});
		const ok = await gw.brokerSession({
			subject: "u",
			target: "ssh:x",
			preferSecretless: true,
			elevatedToken: elev.token,
		});
		expect(ok.kind).toBe("teleport");
		await gw.stop();
	});

	it("hands a local session to a resident protocol adapter", async () => {
		const gw = createNativePamGateway({ isolationClass: "development" });
		await gw.start({
			stationId: "s1",
			tenant: "acme",
			isolationClass: "development",
			trustDomain: "yard.local",
		});
		const session = await gw.brokerSession({
			subject: "user:dev",
			target: { id: "ssh:box", kind: "ssh", isolationClass: "development" },
			preferSecretless: true,
		});
		expect(gw.handoffSession(session.sessionId).sessionId).toBe(
			session.sessionId,
		);
		await gw.stop();
		expect(
			gw.auditEvents.some(
				(event) =>
					event.type === "pam.SessionEnded" &&
					event.sessionId === session.sessionId,
			),
		).toBe(false);
	});

	it("session broker tokens are integrity-checked", () => {
		const keys = createSessionBrokerKeys();
		const { token, claims } = mintSessionToken({
			keys,
			claims: {
				sid: "s1",
				sub: "user:a",
				tgt: "ssh:t",
				env: "staging",
				kind: "boundary",
				station: "st",
				ttlSeconds: 60,
			},
		});
		const ok = verifySessionToken({ token, keys, expectedEnv: "staging" });
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.claims.jti).toBe(claims.jti);
		const bad = verifySessionToken({
			token: `${token.slice(0, -4)}xxxx`,
			keys,
		});
		expect(bad.ok).toBe(false);
	});

	it("renders fail-closed Tailscale ACL document", () => {
		const acl = renderEnvIsolationTailscaleAcl({
			crossEnvGrantTags: [
				{
					from: "development",
					to: "staging",
					grantTag: "tag:grant-dev-to-stage",
				},
			],
		});
		expect(acl.schemaVersion).toContain("tailscale-acl");
		expect(acl.acls.length).toBeGreaterThan(5);
		expect(acl.tagOwners["tag:env-production"]).toBeDefined();
		expect(acl.notes.some((n) => n.includes("ElevatedAccessCapability"))).toBe(
			true,
		);
	});

	it("applyEnvIsolationAclHints applies DNS when client provided", async () => {
		const calls: string[] = [];
		const result = await applyEnvIsolationAclHints({
			acl: renderEnvIsolationTailscaleAcl(),
			tailscale: {
				setDnsPreferences: async () => {
					calls.push("dns");
				},
				putSplitDns: async () => {
					calls.push("split");
				},
			},
		});
		expect(result.applied).toBe(true);
		expect(calls).toEqual(["dns", "split"]);
	});
});
