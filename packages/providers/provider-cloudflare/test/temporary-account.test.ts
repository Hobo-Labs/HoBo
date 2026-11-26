import { describe, expect, it } from "vitest";
import {
	createInMemoryTemporaryAccountRegistry,
	observeAndAdoptTemporaryAccount,
	type ProvisionTemporaryAccountYardInput,
	provisionTemporaryAccountYard,
	type TemporaryAccountYardReceipt,
	temporaryAccountProvisionedEvent,
} from "../src/temporary-account.js";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	type ConsentEvidenceInput,
	type ConsentLedgerPort,
	type ConsentRecord,
	createInMemoryConsentLedger,
} from "../src/temporary-account-consent.js";
import {
	createInMemoryOneTimeActionVault,
	createInMemorySecretCustody,
	type SecretCustodyPort,
} from "../src/temporary-account-custody.js";
import {
	isTemporaryAccountError,
	TemporaryAccountError,
} from "../src/temporary-account-errors.js";
import {
	assertTemporaryAccountResourceAllowed,
	assertTemporaryAccountResourceRequest,
	CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWLIST,
	CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT,
	CLOUDFLARE_TEMPORARY_ACCOUNT_DENYLIST,
	CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL,
} from "../src/temporary-account-resources.js";
import {
	accountBody,
	accountResult,
	challengeBody,
	createHappyTransport,
	createStubTransport,
	FAKE_API_TOKEN,
	FAKE_CLAIM_TOKEN,
	FAKE_CLAIM_URL,
} from "./fixtures/temporary-account-fixtures.js";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const ACCOUNT_EXPIRES = NOW + 7 * 60_000;
const CLAIM_EXPIRES = NOW + 9 * 60_000;

const CONSENT: ConsentEvidenceInput = {
	subjectRef: "session:fake-anon-visitor-0001",
	termsUrl: CLOUDFLARE_TERMS_URL,
	privacyUrl: CLOUDFLARE_PRIVACY_URL,
	acceptedAtMs: NOW - 1_000,
	acceptanceMethod: "explicit-checkbox",
};

type Harness = {
	readonly input: ProvisionTemporaryAccountYardInput;
	readonly custody: ReturnType<typeof createInMemorySecretCustody>;
	readonly actionVault: ReturnType<typeof createInMemoryOneTimeActionVault>;
	readonly consentLedger: ReturnType<typeof createInMemoryConsentLedger>;
	readonly transport: ReturnType<typeof createHappyTransport>;
};

function harness(
	overrides: Partial<ProvisionTemporaryAccountYardInput> = {},
): Harness {
	const custody = createInMemorySecretCustody();
	const actionVault = createInMemoryOneTimeActionVault();
	const consentLedger = createInMemoryConsentLedger({ nowMs: () => NOW });
	const transport = createHappyTransport({
		accountExpiresAtMs: ACCOUNT_EXPIRES,
		claimExpiresAtMs: CLAIM_EXPIRES,
	});
	const input: ProvisionTemporaryAccountYardInput = {
		transport,
		custody,
		consentLedger,
		actionVault,
		consent: CONSENT,
		audienceRef: "session:fake-anon-visitor-0001",
		nowMs: NOW,
		idempotencyKey: "fake-idempotency-key-0001",
		...overrides,
	};
	return { input, custody, actionVault, consentLedger, transport };
}

describe("temporary-account resource allowlist", () => {
	it("carries exactly the published supported-resources table", () => {
		expect(CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWLIST.map((r) => r.kind)).toEqual([
			"workers",
			"workers-static-assets",
			"workers-kv",
			"d1",
			"durable-objects",
			"hyperdrive",
			"queues",
			"certificates",
		]);
		expect(CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL).toBe(
			"https://developers.cloudflare.com/workers/platform/claim-deployments/",
		);
		expect(CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT).toBe("2026-08-08");
	});

	it("records the documented numeric ceilings in the doc's own units", () => {
		const byKind = new Map(
			CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWLIST.map((r) => [r.kind, r.limits]),
		);
		expect(byKind.get("workers-static-assets")).toEqual([
			{ key: "maxFileCount", value: 1000, unit: "count" },
			{ key: "maxFileMebibytes", value: 5, unit: "mebibytes" },
		]);
		expect(byKind.get("d1")).toEqual([
			{ key: "maxDatabaseCount", value: 1, unit: "count" },
			{ key: "maxDatabaseMegabytes", value: 100, unit: "megabytes" },
			{ key: "maxTotalMegabytes", value: 100, unit: "megabytes" },
		]);
		expect(byKind.get("hyperdrive")).toEqual([
			{ key: "maxConfigurations", value: 2, unit: "count" },
			{ key: "maxConnections", value: 10, unit: "connections" },
		]);
		expect(byKind.get("queues")).toEqual([
			{ key: "maxQueues", value: 10, unit: "count" },
		]);
	});

	it.each([
		"r2",
		"containers",
		"vectorize",
		"workers-ai",
		"secrets-store",
		"cron-triggers",
	])("rejects %s, which the table does not list", (kind) => {
		expect(() => assertTemporaryAccountResourceAllowed(kind)).toThrowError(
			TemporaryAccountError,
		);
		try {
			assertTemporaryAccountResourceAllowed(kind);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isTemporaryAccountError(error) && error.code).toBe(
				"RESOURCE_NOT_SUPPORTED",
			);
			expect(isTemporaryAccountError(error) && error.reason).toBe(
				"EXPLICITLY_DENIED",
			);
		}
		expect(
			CLOUDFLARE_TEMPORARY_ACCOUNT_DENYLIST.some((e) => e.kind === kind),
		).toBe(true);
	});

	it("fails closed on a product nobody has classified", () => {
		try {
			assertTemporaryAccountResourceAllowed("workers-quantum-mesh");
			expect.unreachable("unknown resources must not be allowed");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isTemporaryAccountError(error) && error.reason).toBe(
				"NOT_IN_ALLOWLIST",
			);
		}
	});

	it("enforces the documented per-resource ceilings", () => {
		expect(
			assertTemporaryAccountResourceRequest({
				kind: "workers-static-assets",
				quantities: { maxFileCount: 1000, maxFileMebibytes: 5 },
			}).kind,
		).toBe("workers-static-assets");
		expect(() =>
			assertTemporaryAccountResourceRequest({
				kind: "d1",
				quantities: { maxDatabaseCount: 2 },
			}),
		).toThrowError(/at most 1 count/u);
		expect(() =>
			assertTemporaryAccountResourceRequest({
				kind: "queues",
				quantities: { maxQueues: 11 },
			}),
		).toThrowError(/at most 10 count/u);
	});
});

describe("consent", () => {
	it("fails closed with CONSENT_REQUIRED when no acceptance was recorded", async () => {
		const { input } = harness({ consent: undefined });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "CONSENT_REQUIRED",
			reason: "MISSING",
		});
	});

	it("rejects acceptance that points at the wrong policy documents", async () => {
		const { input } = harness({
			consent: { ...CONSENT, termsUrl: "https://example.invalid/terms" },
		});
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "CONSENT_REQUIRED",
			reason: "WRONG_TERMS_URL",
		});
	});

	it("persists consent before the first provider call", async () => {
		const recorded: string[] = [];
		const ledger = createInMemoryConsentLedger({ nowMs: () => NOW });
		const wrapped: ConsentLedgerPort = {
			async record(evidence): Promise<ConsentRecord> {
				recorded.push("consent");
				return ledger.record(evidence);
			},
			async find(ref) {
				return ledger.find(ref);
			},
		};
		const transport = createHappyTransport({
			accountExpiresAtMs: ACCOUNT_EXPIRES,
			claimExpiresAtMs: CLAIM_EXPIRES,
			onSend: () => recorded.push("provider-call"),
		});
		const { input } = harness({ consentLedger: wrapped, transport });
		await provisionTemporaryAccountYard(input);
		expect(recorded[0]).toBe("consent");
		expect(recorded).toContain("provider-call");
	});

	it("never sends acceptTermsOfService without a persisted record", async () => {
		const { input, transport } = harness({ consent: undefined });
		// A bare `rejects.toThrow()` here proved only "something went wrong
		// before the first request", which a harness typo satisfies just as
		// well as the consent gate. Name the gate: CONSENT_REQUIRED/MISSING is
		// the branch that must fire when no consent was supplied at all.
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			name: "TemporaryAccountError",
			code: "CONSENT_REQUIRED",
			reason: "MISSING",
		});
		expect(transport.requests).toHaveLength(0);
	});
});

describe("provisionTemporaryAccountYard", () => {
	it("keeps the API token and claim URL out of everything it returns", async () => {
		const { input, custody } = harness();
		const receipt = await provisionTemporaryAccountYard(input);
		const event = temporaryAccountProvisionedEvent(receipt, NOW);

		for (const serialized of [
			JSON.stringify(receipt),
			JSON.stringify(event),
			JSON.stringify(receipt.lease),
			String(receipt.apiTokenRef),
			String(receipt.claimActionRef),
		]) {
			expect(serialized).not.toContain(FAKE_API_TOKEN);
			expect(serialized).not.toContain(FAKE_CLAIM_URL);
			expect(serialized).not.toContain(FAKE_CLAIM_TOKEN);
			expect(serialized).not.toContain("dash.cloudflare.com");
		}

		// The token is reachable only through custody, by reference.
		expect(await custody.has(receipt.apiTokenRef)).toBe(true);
		expect(
			receipt.apiTokenRef.startsWith("hobo-token://cloudflare-temporary/"),
		).toBe(true);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("models the claim URL as an opaque one-time action reference", async () => {
		const { input, actionVault } = harness();
		const receipt = await provisionTemporaryAccountYard(input);

		expect(receipt.claimActionRef).toMatch(
			/^hobo-action:cloudflare\.claim-deployment:/u,
		);
		const described = await actionVault.describe(receipt.claimActionRef);
		expect(described).toBeDefined();
		expect(JSON.stringify(described)).not.toContain(FAKE_CLAIM_TOKEN);
		expect(described?.redeemed).toBe(false);
		expect(described?.expiresAtMs).toBe(CLAIM_EXPIRES);
	});

	it("records the lease from the provider response, not from a local timer", async () => {
		const { input } = harness();
		const receipt = await provisionTemporaryAccountYard(input);

		expect(receipt.lease.leaseSource).toBe("provider-response");
		expect(receipt.lease.accountExpiresAtMs).toBe(ACCOUNT_EXPIRES);
		expect(receipt.lease.claimExpiresAtMs).toBe(CLAIM_EXPIRES);
		// The documented 60-minute window is recorded as documentation only.
		expect(receipt.lease.documentedClaimWindowMinutes).toBe(60);
		expect(receipt.lease.claimExpiresAtMs).not.toBe(NOW + 60 * 60_000);
		expect(receipt.lease.documentedClaimWindowCheckedAt).toBe("2026-08-08");
	});

	it("declares reauthorization-required creator authority and one claim action", async () => {
		const { input } = harness();
		const receipt = await provisionTemporaryAccountYard(input);
		expect(receipt.creatorAuthorityAfterClaim).toBe("reauthorization-required");
		expect(receipt.claimActionCount).toBe(1);
		expect(receipt.allowedResources).toContain("d1");
		expect(receipt.allowedResources).not.toContain("r2");
	});

	it("fails closed when secret custody is unavailable", async () => {
		const broken: SecretCustodyPort = {
			async deposit() {
				throw new Error("custody offline");
			},
			async destroy() {},
			async has() {
				return false;
			},
		};
		const { input } = harness({ custody: broken });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "SECRET_CUSTODY_UNAVAILABLE",
		});
	});

	it("refuses a proof-of-work challenge above the configured budget", async () => {
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody(4, 4) },
			create: {
				status: 200,
				body: accountBody({
					accountExpiresAtMs: ACCOUNT_EXPIRES,
					claimExpiresAtMs: CLAIM_EXPIRES,
				}),
			},
		});
		const { input } = harness({ transport, maxProofOfWork: 4 });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "WORK_BUDGET_EXCEEDED",
		});
	});

	it("rejects a claim deadline that already passed", async () => {
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody() },
			create: {
				status: 200,
				body: accountBody({
					accountExpiresAtMs: ACCOUNT_EXPIRES,
					claimExpiresAtMs: NOW - 1,
				}),
			},
		});
		const { input } = harness({ transport });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "CLAIM_EXPIRED",
		});
	});
});

describe("typed provider errors", () => {
	it.each([
		[429, "PROVIDER_RATE_LIMITED"],
		[401, "PROVIDER_AUTH_FAILED"],
		[403, "PROVIDER_AUTH_FAILED"],
	])("maps HTTP %i on the challenge call to %s", async (status, code) => {
		const transport = createStubTransport({
			challenge: { status, body: "{}" },
		});
		const { input } = harness({ transport });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code,
		});
	});

	/**
	 * A rate-limited caller's only useful next question is "how long". The
	 * header is optional and its value is attacker-adjacent — it comes off the
	 * wire — so the parse is deliberately narrow, and everything it cannot read
	 * becomes "no advice" rather than a bad number a caller would sleep on.
	 */
	async function rateLimitDetail(
		headers: Record<string, string>,
	): Promise<TemporaryAccountError> {
		const challenge = { status: 429, body: "{}", headers };
		const transport = createStubTransport({ challenge });
		const { input } = harness({ transport });
		try {
			await provisionTemporaryAccountYard(input);
		} catch (error) {
			if (error instanceof TemporaryAccountError) return error;
			throw error;
		}
		throw new Error("expected a rate-limit refusal");
	}

	it("surfaces a Retry-After the provider sent", async () => {
		expect(await rateLimitDetail({ "retry-after": "30" })).toMatchObject({
			code: "PROVIDER_RATE_LIMITED",
			retryAfterSeconds: 30,
		});
	});

	it("reads Retry-After whichever way the header is cased", async () => {
		// HTTP header names are case-insensitive and transports differ about
		// whether they normalise them. Reading only one casing would drop the
		// advice on whichever transport disagreed.
		expect(await rateLimitDetail({ "Retry-After": "30" })).toMatchObject({
			retryAfterSeconds: 30,
		});
	});

	it("accepts an immediate retry", async () => {
		// Zero is a real answer -- `>= 0`, not `> 0` -- and dropping it would turn
		// "you may retry now" into "no advice".
		expect(await rateLimitDetail({ "retry-after": "0" })).toMatchObject({
			retryAfterSeconds: 0,
		});
	});

	it("gives no advice rather than bad advice", async () => {
		// The header comes off the wire. A date-form Retry-After, a negative, or
		// junk all become absent instead of a number a caller would sleep on:
		// `Number("soon")` is NaN and `-5` fails the sign check.
		for (const raw of ["Wed, 21 Oct 2026 07:28:00 GMT", "-5", "soon"]) {
			const detail = await rateLimitDetail({ "retry-after": raw });
			expect(detail.code).toBe("PROVIDER_RATE_LIMITED");
			expect(detail.retryAfterSeconds).toBeUndefined();
		}
	});

	it("reads an empty Retry-After as an immediate retry", async () => {
		// Recorded rather than argued with. `Number("")` is 0, which is finite and
		// non-negative, so a header present but empty is read as "retry now"
		// rather than as no advice. Defensible -- the provider did send the
		// header -- but it is a consequence of the coercion rather than a choice
		// the code states, so it is pinned here to stay deliberate.
		expect(await rateLimitDetail({ "retry-after": "" })).toMatchObject({
			retryAfterSeconds: 0,
		});
	});

	it("omits the field entirely when the provider sent no header", async () => {
		expect((await rateLimitDetail({})).retryAfterSeconds).toBeUndefined();
	});

	it("maps a 503 on the mutating call to PROVIDER_OPERATION_AMBIGUOUS", async () => {
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody() },
			create: { status: 503, body: "{}" },
		});
		const { input } = harness({ transport });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
	});

	it("maps a changed response shape to PROVIDER_CONTRACT_CHANGED", async () => {
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody() },
			create: {
				status: 200,
				body: JSON.stringify({
					success: true,
					result: { account: { id: "fake-account-id" }, claim: { url: "x" } },
				}),
			},
		});
		const { input } = harness({ transport });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "PROVIDER_CONTRACT_CHANGED",
			reason: "MISSING_FIELD",
		});
	});

	it("bounds the response size", async () => {
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody(), truncated: true },
		});
		const { input } = harness({ transport });
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "PROVIDER_RESPONSE_TOO_LARGE",
		});
	});

	it("serializes to a log-safe shape", () => {
		const error = new TemporaryAccountError(
			"PROVIDER_RATE_LIMITED",
			"slow down",
			{
				reason: "TOO_FAST",
				retryAfterSeconds: 30,
			},
		);
		expect(error.toJSON()).toEqual({
			name: "TemporaryAccountError",
			code: "PROVIDER_RATE_LIMITED",
			reason: "TOO_FAST",
			retryable: true,
		});
	});
});

describe("idempotency and ambiguous-timeout adoption", () => {
	it("replays the stored receipt for a repeated idempotency key", async () => {
		const registry = createInMemoryTemporaryAccountRegistry();
		const first = await provisionTemporaryAccountYard(
			harness({ registry }).input,
		);
		const second = await provisionTemporaryAccountYard(
			harness({ registry }).input,
		);
		expect(second).toBe(first);
	});

	it("adopts an account observed after an ambiguous create", async () => {
		const registry = createInMemoryTemporaryAccountRegistry();
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody() },
			createThrows: new Error("socket hang up"),
		});
		const { input, custody, actionVault } = harness({ registry, transport });

		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
		expect(
			await registry.findAttempt("fake-idempotency-key-0001"),
		).toMatchObject({ stage: "create-account" });

		const adopted = await observeAndAdoptTemporaryAccount({
			transport,
			custody,
			actionVault,
			audienceRef: input.audienceRef,
			nowMs: NOW,
			idempotencyKey: "fake-idempotency-key-0001",
			registry,
			consentEvidenceRef: "hobo-consent://cloudflare-temporary/consent-000001",
			observe: async () => ({
				outcome: "found",
				result: accountResult({
					accountExpiresAtMs: ACCOUNT_EXPIRES,
					claimExpiresAtMs: CLAIM_EXPIRES,
				}),
			}),
		});

		expect(adopted.outcome).toBe("adopted");
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const receipt = (adopted as { receipt: TemporaryAccountYardReceipt })
			.receipt;
		expect(receipt.adopted).toBe(true);
		expect(JSON.stringify(receipt)).not.toContain(FAKE_API_TOKEN);
		expect(
			await registry.findAttempt("fake-idempotency-key-0001"),
		).toBeUndefined();
	});

	it("reports not-created when observation finds nothing", async () => {
		const registry = createInMemoryTemporaryAccountRegistry();
		const transport = createStubTransport({
			challenge: { status: 200, body: challengeBody() },
			createThrows: new Error("socket hang up"),
		});
		const { input, custody, actionVault } = harness({ registry, transport });
		// The stub fails the *create* call, and it is specifically the
		// mutating-call-of-unknown-outcome branch — `PROVIDER_OPERATION_AMBIGUOUS`
		// — that makes observe-and-adopt the right next move. A bare
		// `rejects.toThrow()` could not tell that from `PROVIDER_UNAVAILABLE`
		// on the non-mutating challenge call, which would mean the adoption
		// path below was probing a state nothing had ever tried to create.
		await expect(provisionTemporaryAccountYard(input)).rejects.toMatchObject({
			name: "TemporaryAccountError",
			code: "PROVIDER_OPERATION_AMBIGUOUS",
			reason: "TRANSPORT_ERROR",
			message: "cloudflare preview account transport failed",
		});

		const result = await observeAndAdoptTemporaryAccount({
			transport,
			custody,
			actionVault,
			audienceRef: input.audienceRef,
			nowMs: NOW,
			idempotencyKey: "fake-idempotency-key-0001",
			registry,
			consentEvidenceRef: "hobo-consent://cloudflare-temporary/consent-000001",
			observe: async () => ({ outcome: "not-created" }),
		});
		expect(result.outcome).toBe("not-created");
	});
});

describe("transport safety", () => {
	it("only ever addresses api.cloudflare.com over https", async () => {
		const { input, transport } = harness();
		await provisionTemporaryAccountYard(input);
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const request of transport.requests) {
			const url = new URL(request.url);
			expect(url.protocol).toBe("https:");
			expect(url.hostname).toBe("api.cloudflare.com");
			expect(request.timeoutMs).toBeLessThanOrEqual(60_000);
			expect(request.maxResponseBytes).toBe(262_144);
		}
	});
});
