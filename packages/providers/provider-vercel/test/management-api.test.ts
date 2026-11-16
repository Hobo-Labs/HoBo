import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { createOneTimeActionStore } from "@hobo/claims";
import { describe, expect, it } from "vitest";

import {
	type AssociatedResourceOwnershipProbe,
	assertAllowedEndpoint,
	buildClaimAction,
	createGuardedTransport,
	createProjectTransferRequest,
	DEFAULT_TRANSPORT_POLICY,
	getProject,
	isVercelProviderError,
	observeOrAdoptProject,
	revokeSponsorAuthority,
	revokeSponsoringToken,
	rotateAssociatedResourceBinding,
	type SponsoringCredential,
	storeClaimAction,
	summarizePostClaimVerification,
	type TransportRequest,
	type TransportResponse,
	VERCEL_API_ALLOWED_HOSTS,
	type VercelTransport,
	verifyAssociatedResourceOwnership,
	verifyProjectOwnership,
	verifyTransferAcceptanceCallback,
} from "../src/index.js";

const FIXTURES = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);

function fixture(name: string): string {
	return readFileSync(path.join(FIXTURES, name), "utf8");
}

const SPONSOR_ACCOUNT = "team_FAKEhobosponsor0000000";
const CLAIMING_ACCOUNT = "team_FAKEclaiminguser000000";
const PROJECT_ID = "prj_FAKEsponsoredproject000000";

/** Obviously fake, and wrapped so it cannot be stringified by accident. */
function sponsoringCredential(): SponsoringCredential {
	return {
		token: new SecretValue(
			parseSecretRef("hobo-token://vercel/sponsor/example"),
			"FAKE-sponsor-token-000000000000",
		),
		sponsorAccountId: SPONSOR_ACCOUNT,
		tokenId: "FAKEtokenid0000000000000",
	};
}

type Recorded = { readonly request: TransportRequest };

type ScriptedTransport = {
	readonly transport: VercelTransport;
	readonly calls: Recorded[];
};

function scriptedTransport(
	responses: readonly TransportResponse[],
): ScriptedTransport {
	const calls: Recorded[] = [];
	let index = 0;
	const inner: VercelTransport = {
		async request(request) {
			calls.push({ request });
			const response = responses[Math.min(index, responses.length - 1)];
			index += 1;
			if (response === undefined) throw new Error("no scripted response");
			return response;
		},
	};
	return { transport: createGuardedTransport(inner), calls };
}

function ok(body: string): TransportResponse {
	return { status: 200, headers: {}, body };
}

describe("outbound requests are pinned to the official API", () => {
	it("accepts only https, the allowlisted host, and documented path prefixes", () => {
		expect(VERCEL_API_ALLOWED_HOSTS).toEqual(["api.vercel.com"]);
		expect(
			assertAllowedEndpoint(
				"https://api.vercel.com/v9/projects/prj_1",
				DEFAULT_TRANSPORT_POLICY,
			).hostname,
		).toBe("api.vercel.com");

		// Six distinct refusals — scheme, lookalike host, userinfo, non-default
		// port, off-prefix path, unparseable. The previous matcher was
		// `/PROVIDER|https|host|path|url/iu`, which every one of core's guard
		// messages satisfies, so the six rows were interchangeable: any single
		// check could have been deleted and this loop would still have gone
		// green on a neighbouring refusal's wording. Each row now names the
		// guard branch it is here to exercise.
		const refusals: readonly [url: string, guard: string, fragment: RegExp][] =
			[
				[
					"http://api.vercel.com/v9/projects/prj_1",
					"TRANSPORT_SCHEME_FORBIDDEN",
					/^request url must use https, got http$/u,
				],
				[
					"https://api.vercel.com.attacker.example/v9/projects/prj_1",
					"TRANSPORT_HOST_FORBIDDEN",
					/^host api\.vercel\.com\.attacker\.example is not exactly one of the allowlisted provider hosts \(api\.vercel\.com\)$/u,
				],
				[
					"https://user:pass@api.vercel.com/v9/projects/prj_1",
					"TRANSPORT_HOST_FORBIDDEN",
					/must not embed userinfo/u,
				],
				[
					"https://api.vercel.com:8443/v9/projects/prj_1",
					"TRANSPORT_HOST_FORBIDDEN",
					// Vercel names no extra port, so the allowed set is 443 alone.
					// Anchored on both the set and the rejected port: a policy that
					// silently widened would no longer match.
					/^request url must use the default https port or one this policy allows \(443\), got 8443$/u,
				],
				[
					"https://api.vercel.com/v1/undocumented/thing",
					"TRANSPORT_PATH_FORBIDDEN",
					/^path \/v1\/undocumented\/thing is outside the allowlisted prefixes \(/u,
				],
				[
					"not a url",
					"TRANSPORT_SCHEME_FORBIDDEN",
					/^request url is not a valid absolute URL$/u,
				],
			];
		for (const [url, guard, fragment] of refusals) {
			try {
				assertAllowedEndpoint(url, DEFAULT_TRANSPORT_POLICY);
				throw new Error(`${url} was admitted`);
			} catch (cause) {
				if (!(cause instanceof Error)) throw cause;
				expect(isVercelProviderError(cause), `${url} was admitted`).toBe(true);
				if (!isVercelProviderError(cause)) continue;
				expect(cause.code).toBe("PROVIDER_CONTRACT_CHANGED");
				// `detail.guard` carries core's own refusal code and is the only
				// thing that distinguishes one refusal from another here: every
				// guard failure surfaces as the same provider-level code.
				expect(cause.detail).toMatchObject({ guard });
				expect(cause.message).toMatch(fragment);
			}
		}
	});

	it("refuses an encoded separator that survives URL parsing", () => {
		// Regression, and the reason this package's guard delegates to core.
		// Precision matters here and an earlier version of this test lacked it:
		// `/v9/projects/%2e%2e/user/tokens` is NOT one of these cases — WHATWG
		// treats `%2e` as a dot and collapses it to `/v9/user/tokens` during
		// parsing, which the old prefix check refused on its own. Asserting a
		// generic throw made that case look like a hole when it never was.
		//
		// `%2f` and `%5c` are the real ones: not separators to the parser, so
		// they keep the prefix intact, pass `startsWith`, and are decoded only
		// by the origin — with the sponsoring credential attached.
		for (const url of [
			"https://api.vercel.com/v9/projects/%2f%2e%2e%2fv3/user/tokens/abc",
			"https://api.vercel.com/v9/projects/..%5cadmin",
		]) {
			expect(() =>
				assertAllowedEndpoint(url, DEFAULT_TRANSPORT_POLICY),
			).toThrow(/percent-encodes/u);
		}

		// The legitimate path must survive the tightening.
		expect(
			assertAllowedEndpoint(
				"https://api.vercel.com/v9/projects/prj_1",
				DEFAULT_TRANSPORT_POLICY,
			).pathname,
		).toBe("/v9/projects/prj_1");
	});

	it("never follows a redirect and never reads past the byte cap", async () => {
		const redirecting = createGuardedTransport({
			async request() {
				return {
					status: 302,
					headers: { location: "https://attacker.example/steal" },
					body: "",
				};
			},
		});
		await expect(
			redirecting.request({
				method: "GET",
				url: "https://api.vercel.com/v9/projects/prj_1",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow(/redirect/u);

		const oversized = createGuardedTransport(
			{
				async request() {
					return { status: 200, headers: {}, body: "x".repeat(4096) };
				},
			},
			{ ...DEFAULT_TRANSPORT_POLICY, maxResponseBytes: 512 },
		);
		await expect(
			oversized.request({
				method: "GET",
				url: "https://api.vercel.com/v9/projects/prj_1",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 512,
			}),
		).rejects.toThrow(/byte cap/u);
	});
});

describe("transfer request and project reads", () => {
	it("seals the returned code and derives the documented 24 hour expiry", async () => {
		const { transport, calls } = scriptedTransport([
			ok(fixture("transfer-request.created.json")),
		]);
		const issuedAt = Date.UTC(2026, 7, 8, 12, 0, 0);
		const request = await createProjectTransferRequest(
			transport,
			sponsoringCredential(),
			{ projectId: PROJECT_ID, issuedAt },
		);
		expect(request.expiresAt).toBe(issuedAt + 24 * 60 * 60 * 1000);
		// The code is a SecretValue: printing it yields a redacted locator.
		expect(String(request.code)).not.toContain("FAKE-00000000");
		expect(JSON.stringify(request)).not.toContain("FAKE-00000000");
		expect(request.code.expose()).toBe(
			"FAKE-00000000-0000-4000-8000-000000000000",
		);
		expect(calls[0]?.request.url).toBe(
			`https://api.vercel.com/projects/${PROJECT_ID}/transfer-request`,
		);
		expect(calls[0]?.request.method).toBe("POST");
	});

	it("maps provider statuses onto stable HoBo codes", async () => {
		const cases: readonly {
			readonly status: number;
			readonly method: "GET" | "POST";
			readonly code: string;
			readonly retryable: boolean;
		}[] = [
			{
				status: 429,
				method: "POST",
				code: "PROVIDER_RATE_LIMITED",
				retryable: true,
			},
			{
				status: 401,
				method: "POST",
				code: "PROVIDER_AUTH_FAILED",
				retryable: false,
			},
			{ status: 410, method: "POST", code: "CLAIM_EXPIRED", retryable: false },
			{
				status: 503,
				method: "POST",
				code: "PROVIDER_OPERATION_AMBIGUOUS",
				retryable: false,
			},
			{
				status: 503,
				method: "GET",
				code: "PROVIDER_CONTRACT_CHANGED",
				retryable: true,
			},
			{
				status: 418,
				method: "GET",
				code: "PROVIDER_CONTRACT_CHANGED",
				retryable: false,
			},
		];
		for (const scenario of cases) {
			const { transport } = scriptedTransport([
				{
					status: scenario.status,
					headers: { "retry-after": "2" },
					body: fixture("transfer-request.expired.json"),
				},
			]);
			const call =
				scenario.method === "POST"
					? createProjectTransferRequest(transport, sponsoringCredential(), {
							projectId: PROJECT_ID,
							issuedAt: 0,
						})
					: getProject(transport, sponsoringCredential(), {
							projectId: PROJECT_ID,
						});
			await call.then(
				() => expect.unreachable(`expected ${scenario.status} to fail`),
				(error: Error) => {
					expect(isVercelProviderError(error)).toBe(true);
					if (isVercelProviderError(error)) {
						expect(error.code).toBe(scenario.code);
						expect(error.retryable).toBe(scenario.retryable);
					}
				},
			);
		}
	});

	it("rejects a response missing a documented field instead of guessing", async () => {
		const { transport } = scriptedTransport([
			ok('{"name":"x","accountId":"y"}'),
		]);
		await expect(
			getProject(transport, sponsoringCredential(), { projectId: PROJECT_ID }),
		).rejects.toThrow(/missing the documented id field/u);
	});

	it("adopts an already-transferred project after an ambiguous mutation", async () => {
		const { transport } = scriptedTransport([
			ok(fixture("project.after-transfer.json")),
		]);
		await expect(
			observeOrAdoptProject(transport, sponsoringCredential(), {
				projectId: PROJECT_ID,
			}),
		).resolves.toEqual({
			state: "already-transferred",
			accountId: CLAIMING_ACCOUNT,
		});

		const stillOurs = scriptedTransport([
			ok(fixture("project.owned-by-sponsor.json")),
		]);
		await expect(
			observeOrAdoptProject(stillOurs.transport, sponsoringCredential(), {
				projectId: PROJECT_ID,
			}),
		).resolves.toEqual({
			state: "owned-by-sponsor",
			accountId: SPONSOR_ACCOUNT,
		});

		const denied = scriptedTransport([
			{ status: 403, headers: {}, body: "{}" },
		]);
		await expect(
			observeOrAdoptProject(denied.transport, sponsoringCredential(), {
				projectId: PROJECT_ID,
			}),
		).resolves.toEqual({ state: "unreachable-by-sponsor" });
	});
});

describe("both ownership facts are verified independently", () => {
	const probe = (result: {
		readonly ownerAccountRef: string;
		readonly resourceReachable: boolean;
	}): AssociatedResourceOwnershipProbe => ({
		async probe() {
			return { ...result, evidenceRef: "evidence://prisma-postgres/FAKE" };
		},
	});

	it("verifies the project through the account id that owns it", async () => {
		const { transport } = scriptedTransport([
			ok(fixture("project.after-transfer.json")),
		]);
		const verification = await verifyProjectOwnership(
			transport,
			sponsoringCredential(),
			{
				projectId: PROJECT_ID,
				expectedAccountId: CLAIMING_ACCOUNT,
				acceptanceVerified: true,
				evidenceRef: "evidence://vercel/project/FAKE",
			},
		);
		expect(verification.verified).toBe(true);
		expect(verification.observedAccountId).toBe(CLAIMING_ACCOUNT);
	});

	it("does not accept sponsor access loss alone as proof of a claim", async () => {
		const { transport } = scriptedTransport([
			{ status: 403, headers: {}, body: "{}" },
		]);
		const unsigned = await verifyProjectOwnership(
			transport,
			sponsoringCredential(),
			{
				projectId: PROJECT_ID,
				expectedAccountId: CLAIMING_ACCOUNT,
				acceptanceVerified: false,
				evidenceRef: "evidence://vercel/project/FAKE",
			},
		);
		expect(unsigned.verified).toBe(false);
		expect(unsigned.failureCode).toBe("CLAIM_NOT_VERIFIED");
		expect(unsigned.sponsorAccessRemoved).toBe(true);
	});

	it("catches the project-moved-database-did-not case", async () => {
		const resource = await verifyAssociatedResourceOwnership(
			probe({ ownerAccountRef: SPONSOR_ACCOUNT, resourceReachable: true }),
			{
				resourceRef: "hobo://resource/prisma-postgres/FAKEresource000000",
				expectedOwnerAccountRef: CLAIMING_ACCOUNT,
			},
		);
		expect(resource.verified).toBe(false);

		const summary = summarizePostClaimVerification({
			project: {
				verified: true,
				evidenceRef: "evidence://vercel/project/FAKE",
				sponsorAccessRemoved: false,
			},
			associatedResource: resource,
			projectItemId: "vercel-project",
			resourceItemId: "vercel-associated-resource",
		});
		expect(summary.bothSubjectsVerified).toBe(false);
		expect(summary.repairRequiredFor).toEqual(["vercel-associated-resource"]);
	});

	it("verifies the acceptance callback signature before believing the body", () => {
		const secret = new SecretValue(
			parseSecretRef("hobo-secret://vercel/callback/example"),
			"FAKE-callback-secret-0000",
		);
		const rawBody = JSON.stringify({
			projectId: PROJECT_ID,
			targetAccountId: CLAIMING_ACCOUNT,
		});
		const signature = createHmac("sha256", secret.expose())
			.update(rawBody, "utf8")
			.digest("hex");

		expect(
			verifyTransferAcceptanceCallback(
				{ rawBody, signatureHeader: signature },
				secret,
			),
		).toEqual({ projectId: PROJECT_ID, targetAccountId: CLAIMING_ACCOUNT });

		expect(() =>
			verifyTransferAcceptanceCallback(
				{
					rawBody: rawBody.replace(CLAIMING_ACCOUNT, "team_attacker"),
					signatureHeader: signature,
				},
				secret,
			),
		).toThrow(/signature does not match/u);

		expect(() =>
			verifyTransferAcceptanceCallback(
				{ rawBody, signatureHeader: "not-hex" },
				secret,
			),
		).toThrow(/hex HMAC digest/u);
	});
});

describe("post-claim revocation and rotation", () => {
	it("revokes every token known before the claim and tolerates a missing one", async () => {
		const { transport, calls } = scriptedTransport([
			ok(fixture("token.deleted.json")),
			{ status: 404, headers: {}, body: "{}" },
		]);
		const result = await revokeSponsorAuthority(
			transport,
			sponsoringCredential(),
			{
				tokenIdsKnownBeforeClaim: [
					"FAKEtokenid0000000000000",
					"FAKEtokenidgone00000000",
				],
				evidenceRef: "evidence://vercel/revocation/FAKE",
			},
		);
		expect(result.revokedTokenIds).toHaveLength(2);
		expect(result.sponsorPrincipalRemoved).toBe(true);
		expect(calls.map((call) => call.request.method)).toEqual([
			"DELETE",
			"DELETE",
		]);
	});

	it("refuses to claim revocation when the caller recorded no tokens", async () => {
		const { transport } = scriptedTransport([
			ok(fixture("token.deleted.json")),
		]);
		await expect(
			revokeSponsorAuthority(transport, sponsoringCredential(), {
				tokenIdsKnownBeforeClaim: [],
				evidenceRef: "evidence://vercel/revocation/FAKE",
			}),
		).rejects.toThrow(/tokens known before the claim/u);
	});

	it("treats an absent token as revoked rather than an error", async () => {
		const { transport } = scriptedTransport([
			{ status: 404, headers: {}, body: "{}" },
		]);
		await expect(
			revokeSponsoringToken(transport, sponsoringCredential(), {
				tokenId: "gone",
			}),
		).resolves.toEqual({ tokenId: "gone", alreadyGone: true });
	});

	it("rotates the database binding through a reference, never a value", () => {
		const rotated = rotateAssociatedResourceBinding({
			bindingId: "binding-rotated-1",
			resourceRef: "hobo://resource/prisma-postgres/FAKEresource000000",
			rotatedCredentialRef: "hobo-secret://prisma/postgres/rotated-example",
			host: "db.example.invalid",
			port: 5432,
			producerEvidenceRef: "evidence://prisma-postgres/rotation/FAKE",
			rotatedAtMs: Date.UTC(2026, 7, 8),
		});
		expect(rotated.binding.credentialRef).toBe(
			"hobo-secret://prisma/postgres/rotated-example",
		);
		expect(rotated.binding.bindingProfileRef).toBe("binding.postgresql/v1");
		expect(rotated.binding.rotationSupported).toBe(true);

		expect(() =>
			rotateAssociatedResourceBinding({
				bindingId: "binding-bad",
				resourceRef: "hobo://resource/prisma-postgres/FAKEresource000000",
				// A connection string is not a locator, and the boundary says so.
				rotatedCredentialRef:
					"postgres://example:FAKE-password@db.example.invalid:5432/app",
				host: "db.example.invalid",
				producerEvidenceRef: "evidence://prisma-postgres/rotation/FAKE",
				rotatedAtMs: 0,
			}),
		).toThrow(/plaintext credential/u);
	});
});

describe("the claim action stays in custody", () => {
	it("stores the claim URL single-use and hands back only a reference", async () => {
		const cipher = {
			seal: (plaintext: string) =>
				Buffer.from(plaintext, "utf8").toString("base64"),
			open: (sealed: string) => Buffer.from(sealed, "base64").toString("utf8"),
		};
		const store = createOneTimeActionStore(cipher);
		const code = new SecretValue(
			parseSecretRef("hobo-token://vercel/project-transfer/example"),
			"FAKE-00000000-0000-4000-8000-000000000000",
		);
		const action = buildClaimAction({
			transferCode: code,
			projectId: PROJECT_ID,
			returnUrl: "https://example.invalid/done",
		});
		expect(action.expose()).toContain(
			"https://vercel.com/claim-deployment?code=",
		);
		expect(String(action)).not.toContain("code=");

		const issuedAt = Date.UTC(2026, 7, 8, 12, 0, 0);
		const stored = await storeClaimAction({
			store,
			actionId: "ota-1",
			claimAction: action,
			tenantId: "tenant-1",
			projectId: PROJECT_ID,
			sessionId: "session-1",
			issuedAt,
		});
		expect(stored.deadline).toBe(issuedAt + 24 * 60 * 60 * 1000);
		expect(stored.redactedRef).not.toContain("FAKE-00000000");

		const redeemed = await store.redeem({
			id: "ota-1",
			tenantId: "tenant-1",
			projectId: PROJECT_ID,
			sessionId: "session-1",
			audience: "human-owner",
			now: issuedAt + 1000,
		});
		expect(redeemed.value).toContain("claim-deployment");
		await expect(
			store.redeem({
				id: "ota-1",
				tenantId: "tenant-1",
				projectId: PROJECT_ID,
				sessionId: "session-1",
				audience: "human-owner",
				now: issuedAt + 2000,
			}),
		).rejects.toThrow(/already been redeemed/u);
	});

	it("refuses a non-https return url", () => {
		const code = new SecretValue(
			parseSecretRef("hobo-token://vercel/project-transfer/example"),
			"FAKE-code",
		);
		expect(() =>
			buildClaimAction({
				transferCode: code,
				projectId: PROJECT_ID,
				returnUrl: "http://example.invalid/done",
			}),
		).toThrow(/https/u);
	});
});
