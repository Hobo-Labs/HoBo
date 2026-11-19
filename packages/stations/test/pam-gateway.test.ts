import {
	createBoundaryPamGateway,
	createJumpServerPamGateway,
	createTeleportPamGateway,
	mintElevatedAccessCapability,
	PAM_RAIL_CAPABILITY,
} from "@hobo/connectivity";
import { describe, expect, it } from "vitest";

import { railEnablesPam } from "../src/index.js";

describe("Privileged Access Gateway (full secretless)", () => {
	it("Teleport path requires real elevated JWT for production and mints verifiable session", async () => {
		const elevated = mintElevatedAccessCapability({
			subject: "user:alice",
			isolationClass: "production",
			issuedBy: "cp-admin",
			evidence: { kind: "dual-approval", ref: "apr-1" },
			priorAuthnClass: "development",
			allowDefaultSecret: true,
			ttlSeconds: 600,
		});

		const gw = createTeleportPamGateway({
			isolationClass: "production",
			elevatedHmacSecret: "hobo-local-svid-dev-only",
		});
		await gw.start({
			stationId: "station-prod",
			tenant: "acme",
			isolationClass: "production",
			trustDomain: "yard.local",
		});

		await expect(
			gw.brokerSession({
				subject: "user:alice",
				target: "ssh:db",
				preferSecretless: true,
			}),
		).rejects.toMatchObject({ code: "elevated-required" });

		await expect(
			gw.brokerSession({
				subject: "user:alice",
				target: "ssh:db",
				preferSecretless: true,
				elevatedToken: "not-a-jwt",
			}),
		).rejects.toBeTruthy();

		const session = await gw.brokerSession({
			subject: "user:alice",
			target: "ssh:db",
			preferSecretless: true,
			elevatedToken: elevated.token,
			reason: "incident",
			ttlSeconds: 300,
		});
		expect(session.isolationClass).toBe("production");
		expect(session.protocol).toBe("ssh-cert");
		expect(session.credentialRef.startsWith("tokenref://pam/")).toBe(true);
		expect(session.sessionToken.length).toBeGreaterThan(20);

		const verified = gw.verifyLocalSession(session.sessionToken);
		expect(verified.ok).toBe(true);
		if (verified.ok) {
			expect(verified.claims.sub).toBe("user:alice");
			expect(verified.claims.env).toBe("production");
		}

		const renewed = await gw.renewSession(session.sessionId, 600);
		expect(renewed.sessionId).toBe(session.sessionId);
		expect(gw.listSessions()).toHaveLength(1);

		await gw.endSession(session.sessionId, "done");
		expect(gw.listSessions()).toHaveLength(0);
		expect(gw.auditEvents.some((e) => e.type === "pam.SessionStarted")).toBe(
			true,
		);
		expect(gw.auditEvents.some((e) => e.type === "pam.SessionEnded")).toBe(
			true,
		);
		expect(gw.yardDrainCount).toBeGreaterThan(0);
		await gw.stop();
	});

	it("rejects Station context isolation class mismatch", async () => {
		const gw = createJumpServerPamGateway({
			isolationClass: "staging",
		});
		await expect(
			gw.start({
				stationId: "s1",
				tenant: "acme",
				isolationClass: "production",
				trustDomain: "yard.local",
			}),
		).rejects.toMatchObject({ code: "pam-env-mismatch" });
	});

	it("cannot register cross-env target on gateway", async () => {
		const gw = createTeleportPamGateway({ isolationClass: "development" });
		await gw.start({
			stationId: "s-dev",
			tenant: "acme",
			isolationClass: "development",
			trustDomain: "yard.local",
		});
		expect(() =>
			gw.registerTarget({
				id: "ssh:prod-box",
				kind: "ssh",
				isolationClass: "production",
			}),
		).toThrow(/match gateway/);
		await gw.stop();
	});

	it("remote transport issues HTTP authorize when endpoint configured", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		const elevated = mintElevatedAccessCapability({
			subject: "user:alice",
			isolationClass: "staging",
			issuedBy: "cp",
			evidence: { kind: "lower-env-authn", ref: "x" },
			allowDefaultSecret: true,
		});
		const gw = createBoundaryPamGateway({
			isolationClass: "staging",
			elevatedHmacSecret: "hobo-local-svid-dev-only",
			transport: {
				endpoint: "https://boundary.example.test",
				authToken: "test-token",
				fetchImpl: async (url, init) => {
					const method = (init as RequestInit | undefined)?.method ?? "GET";
					calls.push({ url: String(url), method });
					if (method === "POST") {
						return new Response(
							JSON.stringify({
								item: {
									id: "sess-1",
									authorization_token: "at_test",
									authorization_token_id: "sess-1",
									expiration_time: new Date(Date.now() + 600_000).toISOString(),
								},
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					}
					return new Response(null, { status: 204 });
				},
			},
		});
		await gw.start({
			stationId: "s-stage",
			tenant: "acme",
			isolationClass: "staging",
			trustDomain: "yard.local",
		});
		const session = await gw.brokerSession({
			subject: "user:alice",
			target: "db:analytics",
			preferSecretless: true,
			elevatedToken: elevated.token,
		});
		expect(session.credentialRef).toContain("remote=");
		expect(calls.some((c) => c.method === "POST")).toBe(true);
		await gw.endSession(session.sessionId);
		expect(calls.some((c) => c.method === "DELETE")).toBe(true);
		await gw.stop();
	});

	it("railEnablesPam detects capability packs", () => {
		expect(railEnablesPam([PAM_RAIL_CAPABILITY])).toBe(true);
		expect(railEnablesPam(["hobo.bootstrap.least-privilege/v1"])).toBe(false);
		expect(railEnablesPam([], { privilegedAccessGateway: "true" })).toBe(true);
	});
});
