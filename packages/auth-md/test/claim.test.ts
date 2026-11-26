import { describe, expect, it } from "vitest";

import type { AgentRegistration, ClaimInitiation } from "../src/index.js";
import {
	assertBindingMatches,
	discoverAuthMd,
	initiateHumanClaim,
	parseInstant,
	pollHumanClaim,
	preClaimAgentPrincipalClaimRef,
	registerAnonymousAgent,
	resolveClaimScopes,
	toAgentPrincipalClaimRef,
} from "../src/index.js";
import {
	AGREEING_AUTH_MD,
	AUTH_MD_URL,
	binding,
	CLAIM_URL,
	createFetchFixture,
	FAKE_KEY_MATERIAL,
	FAKE_POLL_TOKEN,
	METADATA_URL,
	metadataBody,
	POLL_URL,
	REGISTRATION_URL,
	RESOURCE,
	scopes,
} from "./fixtures.js";

const CLAIM_EXPIRY = "2026-08-08T12:10:00.000Z";

type PollBody = Record<string, unknown>;

async function setup(pollResponses: readonly PollBody[]) {
	const fixture = createFetchFixture({
		[`GET ${METADATA_URL}`]: { json: metadataBody() },
		[`GET ${AUTH_MD_URL}`]: { text: AGREEING_AUTH_MD },
		[`POST ${REGISTRATION_URL}`]: {
			json: {
				registration_ref: "reg_01H8XABCDEF",
				granted_scopes: ["repo:read"],
				private_key: FAKE_KEY_MATERIAL,
				issued_at: "2026-08-08T12:00:00.000Z",
				claim_endpoint: CLAIM_URL,
			},
		},
		[`POST ${CLAIM_URL}`]: {
			json: {
				claim_url: `${RESOURCE}/claim/human`,
				poll_endpoint: POLL_URL,
				poll_token: FAKE_POLL_TOKEN,
				expires_at: CLAIM_EXPIRY,
				interval_seconds: 2,
			},
		},
		[`POST ${POLL_URL}`]: ({ call }) => ({
			json: pollResponses[Math.min(call, pollResponses.length) - 1],
		}),
	});

	const discovery = await discoverAuthMd({
		port: fixture.port,
		resource: RESOURCE,
	});
	const registration = await registerAnonymousAgent({
		port: fixture.port,
		discovery,
		binding: binding(),
		requestedScopes: scopes("repo:read"),
	});
	const initiation = await initiateHumanClaim({
		port: fixture.port,
		registration,
		requestedPostClaimScopes: scopes("repo:read"),
	});
	return { fixture, registration, initiation };
}

const at = (iso: string) => () => new Date(iso);

const poll = (
	fixture: Awaited<ReturnType<typeof setup>>["fixture"],
	registration: AgentRegistration,
	initiation: ClaimInitiation,
	now: string,
	humanAuthorization?: Parameters<
		typeof pollHumanClaim
	>[0]["humanAuthorization"],
) =>
	pollHumanClaim({
		port: fixture.port,
		initiation,
		registration,
		now: at(now),
		...(humanAuthorization === undefined ? {} : { humanAuthorization }),
	});

describe("human claim", () => {
	it("initiates a claim with a human-visible URL and a redacted poll token", async () => {
		const { initiation } = await setup([{ status: "pending" }]);

		expect(initiation.claimUrl).toBe(`${RESOURCE}/claim/human`);
		expect(initiation.intervalSeconds).toBe(2);
		expect(JSON.stringify(initiation)).not.toContain(FAKE_POLL_TOKEN);
	});

	it("reports pending, then the claimed principal", async () => {
		const { fixture, registration, initiation } = await setup([
			{ status: "pending" },
			{
				status: "claimed",
				human_subject: "human:ada",
				granted_scopes: ["repo:read"],
				claimed_at: "2026-08-08T12:05:00.000Z",
			},
		]);

		const first = await poll(
			fixture,
			registration,
			initiation,
			"2026-08-08T12:01:00.000Z",
		);
		expect(first.status).toBe("pending");

		const second = await poll(
			fixture,
			registration,
			initiation,
			"2026-08-08T12:02:00.000Z",
		);
		if (second.status !== "claimed") throw new Error("expected claimed");
		expect(second.principal.phase).toBe("human-bound");
		expect(second.principal.humanSubject).toBe("human:ada");
		expect(second.principal.postClaimScopes).toEqual(["repo:read"]);
		expect(second.principal.rotationSatisfied).toBe(false);
	});

	it("fails closed once the claim window has closed locally", async () => {
		const { fixture, registration, initiation } = await setup([
			{ status: "pending" },
		]);

		await expect(
			poll(fixture, registration, initiation, "2026-08-08T12:30:00.000Z"),
		).rejects.toMatchObject({ code: "AUTHMD_CLAIM_EXPIRED" });
	});

	it("fails closed when the service reports the window closed", async () => {
		const { fixture, registration, initiation } = await setup([
			{ status: "expired" },
		]);

		await expect(
			poll(fixture, registration, initiation, "2026-08-08T12:01:00.000Z"),
		).rejects.toMatchObject({ code: "AUTHMD_CLAIM_EXPIRED" });
	});

	it("rejects a claim that silently widens scopes", async () => {
		const { fixture, registration, initiation } = await setup([
			{
				status: "claimed",
				human_subject: "human:ada",
				granted_scopes: ["repo:read", "issues:write"],
			},
		]);

		await expect(
			poll(fixture, registration, initiation, "2026-08-08T12:01:00.000Z"),
		).rejects.toMatchObject({ code: "AUTHMD_SCOPE_WIDENING_DENIED" });
	});

	it("accepts widened scopes covered by an explicit human authorization", async () => {
		const { fixture, registration, initiation } = await setup([
			{
				status: "claimed",
				human_subject: "human:ada",
				granted_scopes: ["repo:read", "issues:write"],
			},
		]);

		const result = await poll(
			fixture,
			registration,
			initiation,
			"2026-08-08T12:01:00.000Z",
			{
				authorizedScopes: scopes("issues:write"),
				authorizedBy: "human:ada",
				authorizedAt: parseInstant("2026-08-08T12:00:30.000Z"),
			},
		);

		if (result.status !== "claimed") throw new Error("expected claimed");
		expect(result.principal.postClaimScopes).toEqual([
			"repo:read",
			"issues:write",
		]);
	});

	it("reports revocation during the claim window", async () => {
		const { fixture, registration, initiation } = await setup([
			{ status: "revoked" },
		]);

		await expect(
			poll(fixture, registration, initiation, "2026-08-08T12:01:00.000Z"),
		).rejects.toMatchObject({ code: "AUTHMD_REVOKED" });
	});
});

describe("scope resolution", () => {
	it("passes scopes at or below the pre-claim set", () => {
		expect(
			resolveClaimScopes({
				preClaimScopes: scopes("repo:read", "issues:write"),
				grantedScopes: scopes("repo:read"),
			}),
		).toEqual(["repo:read"]);
	});

	it("denies widening when the authorization does not name the added scope", () => {
		expect(() =>
			resolveClaimScopes({
				preClaimScopes: scopes("repo:read"),
				grantedScopes: scopes("repo:read", "admin:all"),
				humanAuthorization: {
					authorizedScopes: scopes("issues:write"),
					authorizedBy: "human:ada",
					authorizedAt: parseInstant("2026-08-08T12:00:00.000Z"),
				},
			}),
		).toThrowError(
			expect.objectContaining({ code: "AUTHMD_SCOPE_WIDENING_DENIED" }),
		);
	});
});

describe("ClaimBundle pointers", () => {
	it("builds a pre-claim pointer with empty post-claim scopes", async () => {
		const { registration } = await setup([{ status: "pending" }]);

		expect(preClaimAgentPrincipalClaimRef(registration)).toEqual({
			protocol: "auth.md",
			registrationRef: "reg_01H8XABCDEF",
			preClaimScopes: ["repo:read"],
			postClaimScopes: [],
			rotateAfterInfrastructureClaim: true,
		});
	});

	it("builds a claimed pointer that keeps both scope sets visible", async () => {
		const { fixture, registration, initiation } = await setup([
			{
				status: "claimed",
				human_subject: "human:ada",
				granted_scopes: ["repo:read"],
			},
		]);

		const result = await poll(
			fixture,
			registration,
			initiation,
			"2026-08-08T12:01:00.000Z",
		);
		if (result.status !== "claimed") throw new Error("expected claimed");

		expect(toAgentPrincipalClaimRef(result.principal)).toEqual({
			protocol: "auth.md",
			registrationRef: "reg_01H8XABCDEF",
			preClaimScopes: ["repo:read"],
			postClaimScopes: ["repo:read"],
			rotateAfterInfrastructureClaim: true,
		});
	});
});

describe("binding enforcement", () => {
	it("refuses a call arriving under a different tenant", () => {
		expect(() =>
			assertBindingMatches(
				binding(),
				binding({ tenantId: "tenant-other" }),
				"reg_01H8XABCDEF",
			),
		).toThrowError(
			expect.objectContaining({ code: "AUTHMD_ASSERTION_INVALID" }),
		);
	});

	it("accepts an identical four-part binding", () => {
		expect(() =>
			assertBindingMatches(binding(), binding(), "reg_01H8XABCDEF"),
		).not.toThrow();
	});
});
