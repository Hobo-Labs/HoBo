import { describe, expect, it } from "vitest";
import {
	provisionTemporaryAccountYard,
	type TemporaryAccountYardReceipt,
} from "../src/temporary-account.js";
import {
	assertManagementAuthorized,
	type ClaimVerificationPort,
	claimCompletedEvent,
	completeTemporaryAccountClaim,
	type OwnershipObservation,
	type ReauthorizationCeremonyPort,
	redeemClaimAction,
} from "../src/temporary-account-claim.js";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	createInMemoryConsentLedger,
} from "../src/temporary-account-consent.js";
import {
	createInMemoryOneTimeActionVault,
	createInMemorySecretCustody,
} from "../src/temporary-account-custody.js";
import {
	createHappyTransport,
	FAKE_API_TOKEN,
	FAKE_CLAIM_TOKEN,
	FAKE_CLAIM_URL,
} from "./fixtures/temporary-account-fixtures.js";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const ACCOUNT_EXPIRES = NOW + 45 * 60_000;
const CLAIM_EXPIRES = NOW + 50 * 60_000;
const AUDIENCE = "session:fake-anon-visitor-0001";

async function provision(): Promise<{
	receipt: TemporaryAccountYardReceipt;
	custody: ReturnType<typeof createInMemorySecretCustody>;
	actionVault: ReturnType<typeof createInMemoryOneTimeActionVault>;
}> {
	const custody = createInMemorySecretCustody();
	const actionVault = createInMemoryOneTimeActionVault();
	const receipt = await provisionTemporaryAccountYard({
		transport: createHappyTransport({
			accountExpiresAtMs: ACCOUNT_EXPIRES,
			claimExpiresAtMs: CLAIM_EXPIRES,
		}),
		custody,
		actionVault,
		consentLedger: createInMemoryConsentLedger({ nowMs: () => NOW }),
		consent: {
			subjectRef: AUDIENCE,
			termsUrl: CLOUDFLARE_TERMS_URL,
			privacyUrl: CLOUDFLARE_PRIVACY_URL,
			acceptedAtMs: NOW - 1_000,
			acceptanceMethod: "cli-confirmation",
		},
		audienceRef: AUDIENCE,
		nowMs: NOW,
		idempotencyKey: "fake-idempotency-key-claim",
	});
	return { receipt, custody, actionVault };
}

function verification(
	observations: readonly OwnershipObservation[],
): ClaimVerificationPort {
	let index = 0;
	return {
		async verifyOwnership() {
			const observation =
				observations[Math.min(index, observations.length - 1)] ??
				({
					owned: false,
					observedAtMs: NOW,
					residualTokenActive: true,
				} as const);
			index += 1;
			return observation;
		},
	};
}

const OWNED: OwnershipObservation = {
	owned: true,
	ownerRef: "cf-owner:fake-0001",
	observedAtMs: NOW + 1_000,
	residualTokenActive: true,
};

const OWNED_AND_CLEAN: OwnershipObservation = {
	...OWNED,
	residualTokenActive: false,
};

describe("redeemClaimAction", () => {
	it("discloses the claim URL exactly once, to the intended audience", async () => {
		const { receipt, actionVault } = await provision();
		const url = await redeemClaimAction({
			receipt,
			actionVault,
			audienceRef: AUDIENCE,
			nowMs: NOW,
		});
		expect(url).toBe(FAKE_CLAIM_URL);

		await expect(
			redeemClaimAction({
				receipt,
				actionVault,
				audienceRef: AUDIENCE,
				nowMs: NOW,
			}),
		).rejects.toMatchObject({ code: "CLAIM_ACTION_CONSUMED" });
	});

	it("refuses an audience the reference was not minted for", async () => {
		const { receipt, actionVault } = await provision();
		await expect(
			redeemClaimAction({
				receipt,
				actionVault,
				audienceRef: "session:someone-else",
				nowMs: NOW,
			}),
		).rejects.toMatchObject({ code: "CLAIM_NOT_VERIFIED" });
	});

	it("refuses after the provider-stated deadline", async () => {
		const { receipt, actionVault } = await provision();
		await expect(
			redeemClaimAction({
				receipt,
				actionVault,
				audienceRef: AUDIENCE,
				nowMs: CLAIM_EXPIRES,
			}),
		).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
	});
});

describe("completeTemporaryAccountClaim", () => {
	it("requires independent ownership verification", async () => {
		const { receipt, custody, actionVault } = await provision();
		await expect(
			completeTemporaryAccountClaim({
				receipt,
				custody,
				actionVault,
				verification: verification([
					{ owned: false, observedAtMs: NOW, residualTokenActive: true },
				]),
				nowMs: NOW + 60_000,
			}),
		).rejects.toMatchObject({ code: "CLAIM_NOT_VERIFIED" });
		// Nothing was revoked on an unverified claim.
		expect(await custody.has(receipt.apiTokenRef)).toBe(true);
	});

	it("refuses once the recorded claim deadline has passed", async () => {
		const { receipt, custody, actionVault } = await provision();
		await expect(
			completeTemporaryAccountClaim({
				receipt,
				custody,
				actionVault,
				verification: verification([OWNED_AND_CLEAN]),
				nowMs: CLAIM_EXPIRES + 1,
			}),
		).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
	});

	it("destroys residual bootstrap credentials", async () => {
		const { receipt, custody, actionVault } = await provision();
		const completion = await completeTemporaryAccountClaim({
			receipt,
			custody,
			actionVault,
			verification: verification([OWNED, OWNED_AND_CLEAN]),
			nowMs: NOW + 60_000,
		});

		expect(completion.ownershipVerified).toBe(true);
		expect(await custody.has(receipt.apiTokenRef)).toBe(false);
		const described = await actionVault.describe(receipt.claimActionRef);
		expect(described?.revoked).toBe(true);
		await expect(
			redeemClaimAction({
				receipt,
				actionVault,
				audienceRef: AUDIENCE,
				nowMs: NOW + 60_000,
			}),
		).rejects.toMatchObject({ code: "CLAIM_ACTION_CONSUMED" });

		const serialized = JSON.stringify(
			claimCompletedEvent(completion, NOW + 60_000),
		);
		expect(serialized).not.toContain(FAKE_API_TOKEN);
		expect(serialized).not.toContain(FAKE_CLAIM_TOKEN);
		expect(serialized).not.toContain(FAKE_CLAIM_URL);
	});

	it("reports BOOTSTRAP_AUTHORITY_REMAINS when the token still authorizes", async () => {
		const { receipt, custody, actionVault } = await provision();
		await expect(
			completeTemporaryAccountClaim({
				receipt,
				custody,
				actionVault,
				verification: verification([OWNED]),
				nowMs: NOW + 60_000,
			}),
		).rejects.toMatchObject({
			code: "BOOTSTRAP_AUTHORITY_REMAINS",
			reason: "TOKEN_STILL_ACTIVE",
		});
	});

	it("treats continuing management as a separate authorization ceremony", async () => {
		const { receipt, custody, actionVault } = await provision();
		const completion = await completeTemporaryAccountClaim({
			receipt,
			custody,
			actionVault,
			verification: verification([OWNED, OWNED_AND_CLEAN]),
			nowMs: NOW + 60_000,
		});

		expect(completion.creatorAuthorityAfterClaim).toBe(
			"reauthorization-required",
		);
		expect(completion.managementAuthorized).toBe(false);
		expect(() =>
			assertManagementAuthorized(completion, NOW + 60_000),
		).toThrowError(/separate post-claim authorization ceremony/u);
	});

	it("authorizes management only through a fresh, unexpired grant", async () => {
		const { receipt, custody, actionVault } = await provision();
		const ceremony: ReauthorizationCeremonyPort = {
			async request({ accountId, ownerRef, nowMs }) {
				return {
					grantId: "grant-0001",
					accountId,
					principalRef: ownerRef,
					scopes: ["workers:write"],
					issuedAtMs: nowMs,
					expiresAtMs: nowMs + 3_600_000,
					ceremony: "post-claim-reauthorization",
				};
			},
		};
		const completion = await completeTemporaryAccountClaim({
			receipt,
			custody,
			actionVault,
			verification: verification([OWNED, OWNED_AND_CLEAN]),
			reauthorization: ceremony,
			nowMs: NOW + 60_000,
		});

		expect(completion.managementAuthorized).toBe(true);
		expect(assertManagementAuthorized(completion, NOW + 60_000).grantId).toBe(
			"grant-0001",
		);
		expect(() =>
			assertManagementAuthorized(completion, NOW + 60_000 + 3_600_001),
		).toThrowError(/expired/u);
	});
});
