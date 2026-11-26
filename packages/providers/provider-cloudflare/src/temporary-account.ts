/**
 * `cloudflare.temporary-account-yard/v1` — a claimable edge Yard.
 *
 * The whole flow runs server-side over an injected transport port. There is no
 * reference to the global `fetch` in this module, which is what lets the same
 * code run inside a test with sanitized fixtures, inside a Node backend, and
 * inside a Worker, and what makes "the browser never sees the token" a
 * structural property rather than a review comment.
 *
 * Order matters and is enforced: consent is parsed and persisted *before* the
 * first provisioning call; the proof-of-work budget is checked before any work
 * is done; the API token goes straight into custody; the claim URL goes straight
 * into a one-time action vault; and the lease is built from the timestamps
 * Cloudflare returned, never from a local timer.
 *
 * Source: https://developers.cloudflare.com/workers/platform/claim-deployments/
 * (doc "Last updated Jul 14, 2026"; re-read 2026-08-08).
 */
import { randomUUID } from "node:crypto";
import type { SecretRef } from "@hobo/bindings";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

import {
	type ConsentEvidenceInput,
	type ConsentLedgerPort,
	type ConsentRecord,
	parseConsentEvidence,
} from "./temporary-account-consent.js";
import {
	depositOrFailClosed,
	type OneTimeActionVaultPort,
	type SecretCustodyPort,
	type SensitiveActionRef,
} from "./temporary-account-custody.js";
import {
	TemporaryAccountError,
	temporaryAccountErrorForStatus,
} from "./temporary-account-errors.js";
import {
	CLOUDFLARE_DOCUMENTED_CLAIM_WINDOW_MINUTES,
	CLOUDFLARE_MAX_PROOF_OF_WORK,
	CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT,
	CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL,
	TEMPORARY_ACCOUNT_RESOURCE_KINDS,
	type TemporaryAccountResourceKind,
} from "./temporary-account-resources.js";
import {
	type PreviewChallenge,
	solvePreviewChallenge,
} from "./temporary-pow.js";

// public-contract: Yard identity used in offers and receipts.
export const CLOUDFLARE_TEMPORARY_ACCOUNT_YARD_ID =
	"cloudflare.temporary-account-yard/v1" as const;

/**
 * Base for the Temporary Accounts REST endpoints.
 *
 * The *flow* is documented and verified — accept Terms and Privacy, request and
 * solve a proof-of-work challenge, create the preview account, deploy with the
 * returned id and token, show the Worker URL and claim URL. The concrete paths
 * and JSON field names below are **not** verified against a published API
 * reference. They are pinned by `parsePreviewAccountResponse`, which refuses any
 * response it does not fully recognise with `PROVIDER_CONTRACT_CHANGED`, so a
 * wrong guess surfaces as a typed refusal rather than a half-parsed account.
 */
// public-contract: documented temporary-account API endpoint.
export const CLOUDFLARE_TEMPORARY_ACCOUNT_API_BASE =
	"https://api.cloudflare.com/client/v4";

/** Only these hosts may be contacted on this path. */
export const CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWED_HOSTS: readonly string[] = [
	"api.cloudflare.com",
];

export const MAX_PROVIDER_RESPONSE_BYTES = 262_144;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_TIMEOUT_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* Transport port                                                             */
/* -------------------------------------------------------------------------- */

export type TemporaryAccountHttpRequest = {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs: number;
	/** Byte ceiling the transport must enforce while reading the response. */
	readonly maxResponseBytes: number;
};

export type TemporaryAccountHttpResponse = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	/** Set by a transport that stopped reading at `maxResponseBytes`. */
	readonly truncated?: boolean;
};

/**
 * The single seam through which this module reaches the network.
 *
 * A transport may reject an ambiguous outcome by throwing a
 * `PROVIDER_OPERATION_AMBIGUOUS` {@link TemporaryAccountError}; anything else it
 * throws is normalized to `PROVIDER_UNAVAILABLE`.
 */
export type TemporaryAccountTransportPort = {
	send(
		request: TemporaryAccountHttpRequest,
	): Promise<TemporaryAccountHttpResponse>;
};

function assertAllowedUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (cause) {
		throw new TemporaryAccountError(
			"TRANSPORT_NOT_ALLOWED",
			"request URL is malformed",
			{
				reason: "MALFORMED_URL",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	}
	if (parsed.protocol !== "https:") {
		throw new TemporaryAccountError(
			"TRANSPORT_NOT_ALLOWED",
			"temporary-account requests must use https",
			{ reason: "NOT_HTTPS" },
		);
	}
	if (!CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWED_HOSTS.includes(parsed.hostname)) {
		throw new TemporaryAccountError(
			"TRANSPORT_NOT_ALLOWED",
			`host ${parsed.hostname} is not on the temporary-account allowlist`,
			{ reason: "HOST_NOT_ALLOWED" },
		);
	}
}

function retryAfterSeconds(
	headers: Readonly<Record<string, string>>,
): number | undefined {
	const raw = headers["retry-after"] ?? headers["Retry-After"];
	if (raw === undefined) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function callCloudflare(
	transport: TemporaryAccountTransportPort,
	request: Omit<
		TemporaryAccountHttpRequest,
		"maxResponseBytes" | "timeoutMs"
	> & {
		readonly timeoutMs?: number;
	},
	options: { readonly stage: string; readonly mutating: boolean },
): Promise<JsonObject> {
	assertAllowedUrl(request.url);
	const timeoutMs = Math.min(
		Math.max(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 1),
		MAX_REQUEST_TIMEOUT_MS,
	);

	let response: TemporaryAccountHttpResponse;
	try {
		response = await transport.send({
			...request,
			timeoutMs,
			maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
		});
	} catch (cause) {
		if (cause instanceof TemporaryAccountError) throw cause;
		throw new TemporaryAccountError(
			options.mutating
				? "PROVIDER_OPERATION_AMBIGUOUS"
				: "PROVIDER_UNAVAILABLE",
			`cloudflare ${options.stage} transport failed`,
			{
				reason: "TRANSPORT_ERROR",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	}

	if (
		response.truncated === true ||
		response.body.length > MAX_PROVIDER_RESPONSE_BYTES
	) {
		throw new TemporaryAccountError(
			"PROVIDER_RESPONSE_TOO_LARGE",
			`cloudflare ${options.stage} response exceeded ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
			{ reason: "RESPONSE_TRUNCATED" },
		);
	}
	if (response.status < 200 || response.status >= 300) {
		const retryAfter = retryAfterSeconds(response.headers);
		throw temporaryAccountErrorForStatus(response.status, {
			stage: options.stage,
			mutating: options.mutating,
			...(retryAfter === undefined
				? undefined
				: { retryAfterSeconds: retryAfter }),
		});
	}

	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this Cloudflare document boundary.
		parsed = JSON.parse(response.body) as JsonValue;
	} catch (cause) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${options.stage} response was not JSON`,
			{
				reason: "NOT_JSON",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	}
	if (!isJsonObject(parsed) || parsed.success !== true) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${options.stage} response did not report success`,
			{ reason: "SUCCESS_FALSE" },
		);
	}
	if (!isJsonObject(parsed.result)) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${options.stage} response carried no result object`,
			{ reason: "MISSING_RESULT" },
		);
	}
	return parsed.result;
}

/* -------------------------------------------------------------------------- */
/* Narrow response parsers                                                    */
/* -------------------------------------------------------------------------- */

function requireString(
	source: JsonObject,
	key: string,
	stage: string,
	bounds: { readonly min: number; readonly max: number },
): string {
	const value = source[key];
	if (!isJsonString(value)) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${stage} response is missing string field ${key}`,
			{ reason: "MISSING_FIELD" },
		);
	}
	if (value.length < bounds.min || value.length > bounds.max) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${stage} field ${key} is outside the expected length bounds`,
			{ reason: "FIELD_OUT_OF_BOUNDS" },
		);
	}
	return value;
}

function requireObject(
	source: JsonObject,
	key: string,
	stage: string,
): JsonObject {
	const value = source[key];
	if (!isJsonObject(value)) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${stage} response is missing object field ${key}`,
			{ reason: "MISSING_FIELD" },
		);
	}
	return value;
}

function requireInstant(value: string, key: string, stage: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			`cloudflare ${stage} field ${key} is not an ISO-8601 instant`,
			{ reason: "INVALID_TIMESTAMP" },
		);
	}
	return parsed;
}

/** Documented challenge shape: `challengeToken`, `seed`, `k`, `g`. */
export function parsePreviewChallengeResponse(
	result: JsonObject,
): PreviewChallenge {
	const challengeToken = requireString(
		result,
		"challengeToken",
		"preview challenge",
		{
			min: 8,
			max: 4096,
		},
	);
	const seed = requireString(result, "seed", "preview challenge", {
		min: 40,
		max: 64,
	});
	const k = result.k;
	const g = result.g;
	if (!Number.isInteger(k) || !Number.isInteger(g)) {
		throw new TemporaryAccountError(
			"PROVIDER_CONTRACT_CHANGED",
			"cloudflare preview challenge did not carry integer k and g",
			{ reason: "MISSING_FIELD" },
		);
	}
	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	return { challengeToken, seed, k: k as number, g: g as number };
}

/** The credential-bearing half of the create response. Never leaves this module. */
type RawPreviewAccount = {
	readonly accountId: string;
	readonly apiToken: string;
	readonly accountExpiresAtMs: number;
	readonly claimUrl: string;
	readonly claimExpiresAtMs: number;
};

export function parsePreviewAccountResponse(
	result: JsonObject,
): RawPreviewAccount {
	const stage = "preview account";
	const account = requireObject(result, "account", stage);
	const claim = requireObject(result, "claim", stage);
	return {
		accountId: requireString(account, "id", stage, { min: 8, max: 128 }),
		apiToken: requireString(account, "apiToken", stage, { min: 16, max: 512 }),
		accountExpiresAtMs: requireInstant(
			requireString(account, "expiresAt", stage, { min: 16, max: 64 }),
			"account.expiresAt",
			stage,
		),
		claimUrl: requireString(claim, "url", stage, { min: 16, max: 2048 }),
		claimExpiresAtMs: requireInstant(
			requireString(claim, "expiresAt", stage, { min: 16, max: 64 }),
			"claim.expiresAt",
			stage,
		),
	};
}

/* -------------------------------------------------------------------------- */
/* Lease and receipt                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The Yard's tenancy, recorded from what the provider actually said.
 *
 * `documentedClaimWindowMinutes` is documentation of Cloudflare's stated 60
 * minutes; every decision uses `claimExpiresAtMs`, which came out of the
 * response body.
 */
export type GuestLease = {
	readonly leaseId: string;
	readonly providerId: "cloudflare";
	readonly yardId: typeof CLOUDFLARE_TEMPORARY_ACCOUNT_YARD_ID;
	readonly accountId: string;
	readonly leaseSource: "provider-response";
	readonly observedAtMs: number;
	readonly accountExpiresAtMs: number;
	readonly claimExpiresAtMs: number;
	readonly documentedClaimWindowMinutes: number;
	readonly documentedClaimWindowSourceUrl: string;
	readonly documentedClaimWindowCheckedAt: string;
};

export function isLeaseActive(lease: GuestLease, nowMs: number): boolean {
	return nowMs < lease.accountExpiresAtMs;
}

export function assertLeaseActive(lease: GuestLease, nowMs: number): void {
	if (!isLeaseActive(lease, nowMs)) {
		throw new TemporaryAccountError(
			"LEASE_EXPIRED",
			"the temporary account lease returned by Cloudflare has expired",
			{ reason: "ACCOUNT_EXPIRED" },
		);
	}
}

/**
 * Everything the rest of HoBo is allowed to see.
 *
 * There is no field here that carries the API token or the claim URL, which is
 * what makes it safe to place in an event, a projection, or a UI payload.
 */
export type TemporaryAccountYardReceipt = {
	readonly schemaVersion: "hobo.cloudflare.temporary-account-yard/v1";
	readonly yardId: typeof CLOUDFLARE_TEMPORARY_ACCOUNT_YARD_ID;
	readonly providerId: "cloudflare";
	readonly accountId: string;
	readonly idempotencyKey: string;
	readonly lease: GuestLease;
	readonly apiTokenRef: SecretRef;
	readonly claimActionRef: SensitiveActionRef;
	readonly consentEvidenceRef: string;
	readonly allowedResources: readonly TemporaryAccountResourceKind[];
	readonly creatorAuthorityAfterClaim: "reauthorization-required";
	readonly claimActionCount: 1;
	readonly adopted: boolean;
};

export type TemporaryAccountProvisionedEvent = {
	readonly type: "yard.TemporaryAccountProvisioned";
	readonly occurredAtMs: number;
	readonly receipt: TemporaryAccountYardReceipt;
};

export function temporaryAccountProvisionedEvent(
	receipt: TemporaryAccountYardReceipt,
	occurredAtMs: number,
): TemporaryAccountProvisionedEvent {
	return { type: "yard.TemporaryAccountProvisioned", occurredAtMs, receipt };
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

export type TemporaryAccountAttempt = {
	readonly idempotencyKey: string;
	readonly stage: "create-account";
	readonly attemptedAtMs: number;
};

/**
 * Records intent before the mutating call so an ambiguous timeout can be
 * resolved by observation instead of by a blind retry that mints a second
 * account.
 */
export type TemporaryAccountRegistryPort = {
	findReceipt(
		idempotencyKey: string,
	): Promise<TemporaryAccountYardReceipt | undefined>;
	putReceipt(receipt: TemporaryAccountYardReceipt): Promise<void>;
	findAttempt(
		idempotencyKey: string,
	): Promise<TemporaryAccountAttempt | undefined>;
	putAttempt(attempt: TemporaryAccountAttempt): Promise<void>;
	clearAttempt(idempotencyKey: string): Promise<void>;
};

export function createInMemoryTemporaryAccountRegistry(): TemporaryAccountRegistryPort {
	const receipts = new Map<string, TemporaryAccountYardReceipt>();
	const attempts = new Map<string, TemporaryAccountAttempt>();
	return {
		async findReceipt(key) {
			return receipts.get(key);
		},
		async putReceipt(receipt) {
			receipts.set(receipt.idempotencyKey, receipt);
		},
		async findAttempt(key) {
			return attempts.get(key);
		},
		async putAttempt(attempt) {
			attempts.set(attempt.idempotencyKey, attempt);
		},
		async clearAttempt(key) {
			attempts.delete(key);
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Provisioning                                                               */
/* -------------------------------------------------------------------------- */

export type ProvisionTemporaryAccountYardInput = {
	readonly transport: TemporaryAccountTransportPort;
	readonly custody: SecretCustodyPort;
	readonly consentLedger: ConsentLedgerPort;
	readonly actionVault: OneTimeActionVaultPort;
	readonly consent: ConsentEvidenceInput | undefined;
	/** Who may later redeem the claim action. Opaque, not PII. */
	readonly audienceRef: string;
	/** Canonical instant. Passed in — this module never reads a clock. */
	readonly nowMs: number;
	readonly idempotencyKey?: string;
	readonly registry?: TemporaryAccountRegistryPort;
	/** Lower the accepted proof-of-work ceiling below Cloudflare's own bound. */
	readonly maxProofOfWork?: number;
	readonly requestTimeoutMs?: number;
};

async function persistConsentFirst(
	input: ProvisionTemporaryAccountYardInput,
): Promise<ConsentRecord> {
	const evidence = parseConsentEvidence(input.consent);
	try {
		return await input.consentLedger.record(evidence);
	} catch (cause) {
		if (cause instanceof TemporaryAccountError) throw cause;
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			"consent evidence could not be persisted before the provisioning call",
			{
				reason: "LEDGER_WRITE_FAILED",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	}
}

/** The narrow slice of the input that turning a raw account into a receipt needs. */
type CaptureContext = {
	readonly custody: SecretCustodyPort;
	readonly actionVault: OneTimeActionVaultPort;
	readonly audienceRef: string;
	readonly nowMs: number;
};

async function captureAccount(
	raw: RawPreviewAccount,
	input: CaptureContext,
	consentEvidenceRef: string,
	idempotencyKey: string,
	adopted: boolean,
): Promise<TemporaryAccountYardReceipt> {
	if (raw.claimExpiresAtMs <= input.nowMs) {
		throw new TemporaryAccountError(
			"CLAIM_EXPIRED",
			"cloudflare returned a claim deadline that has already passed",
			{ reason: "CLAIM_WINDOW_CLOSED" },
		);
	}

	const apiTokenRef = await depositOrFailClosed(input.custody, {
		name: "api-token",
		value: raw.apiToken,
		expiresAtMs: raw.accountExpiresAtMs,
	});

	const claimActionRef = await input.actionVault.store({
		kind: "cloudflare.claim-deployment",
		url: raw.claimUrl,
		audienceRef: input.audienceRef,
		expiresAtMs: raw.claimExpiresAtMs,
	});

	const lease: GuestLease = {
		leaseId: `lease:cloudflare:${raw.accountId}`,
		providerId: "cloudflare",
		yardId: CLOUDFLARE_TEMPORARY_ACCOUNT_YARD_ID,
		accountId: raw.accountId,
		leaseSource: "provider-response",
		observedAtMs: input.nowMs,
		accountExpiresAtMs: raw.accountExpiresAtMs,
		claimExpiresAtMs: raw.claimExpiresAtMs,
		documentedClaimWindowMinutes: CLOUDFLARE_DOCUMENTED_CLAIM_WINDOW_MINUTES,
		documentedClaimWindowSourceUrl: CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL,
		documentedClaimWindowCheckedAt: CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT,
	};

	return {
		schemaVersion: "hobo.cloudflare.temporary-account-yard/v1",
		yardId: CLOUDFLARE_TEMPORARY_ACCOUNT_YARD_ID,
		providerId: "cloudflare",
		accountId: raw.accountId,
		idempotencyKey,
		lease,
		apiTokenRef,
		claimActionRef,
		consentEvidenceRef,
		allowedResources: TEMPORARY_ACCOUNT_RESOURCE_KINDS,
		creatorAuthorityAfterClaim: "reauthorization-required",
		claimActionCount: 1,
		adopted,
	};
}

/**
 * Provision a claimable edge Yard on a Cloudflare temporary account.
 *
 * Throws {@link TemporaryAccountError} with `PROVIDER_OPERATION_AMBIGUOUS` when
 * the create call may or may not have taken effect. Callers must resolve that
 * with {@link observeAndAdoptTemporaryAccount} rather than retrying.
 */
export async function provisionTemporaryAccountYard(
	input: ProvisionTemporaryAccountYardInput,
): Promise<TemporaryAccountYardReceipt> {
	const idempotencyKey = input.idempotencyKey ?? randomUUID();

	const existing = await input.registry?.findReceipt(idempotencyKey);
	if (existing !== undefined) return existing;

	// Consent is recorded before anything is asked of Cloudflare.
	const consent = await persistConsentFirst(input);

	const timeout =
		input.requestTimeoutMs !== undefined
			? { timeoutMs: input.requestTimeoutMs }
			: {};

	const challengeResult = await callCloudflare(
		input.transport,
		{
			method: "POST",
			url: `${CLOUDFLARE_TEMPORARY_ACCOUNT_API_BASE}/provisioning/previews/challenge`,
			headers: { "content-type": "application/json" },
			body: "{}",
			...timeout,
		},
		{ stage: "preview challenge", mutating: false },
	);
	const challenge = parsePreviewChallengeResponse(challengeResult);

	const budget = Math.min(
		input.maxProofOfWork ?? CLOUDFLARE_MAX_PROOF_OF_WORK,
		CLOUDFLARE_MAX_PROOF_OF_WORK,
	);
	if (challenge.k * challenge.g > budget) {
		throw new TemporaryAccountError(
			"WORK_BUDGET_EXCEEDED",
			`cloudflare asked for ${challenge.k * challenge.g} sequential hashes, above the ${budget} budget`,
			{ reason: "PROOF_OF_WORK_TOO_LARGE" },
		);
	}
	const solved = await solvePreviewChallenge(challenge);

	await input.registry?.putAttempt({
		idempotencyKey,
		stage: "create-account",
		attemptedAtMs: input.nowMs,
	});

	const accountResult = await callCloudflare(
		input.transport,
		{
			method: "POST",
			url: `${CLOUDFLARE_TEMPORARY_ACCOUNT_API_BASE}/provisioning/previews`,
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			body: JSON.stringify({
				termsOfService: consent.termsUrl,
				privacyPolicy: consent.privacyUrl,
				acceptTermsOfService: "yes",
				challengeToken: challenge.challengeToken,
				solution: solved.solution,
			}),
			...timeout,
		},
		{ stage: "preview account", mutating: true },
	);

	const receipt = await captureAccount(
		parsePreviewAccountResponse(accountResult),
		input,
		consent.evidenceRef,
		idempotencyKey,
		false,
	);
	await input.registry?.putReceipt(receipt);
	await input.registry?.clearAttempt(idempotencyKey);
	return receipt;
}

export type TemporaryAccountObservation =
	| { readonly outcome: "found"; readonly result: JsonObject }
	| { readonly outcome: "not-created" };

export type ObserveAndAdoptInput = Omit<
	ProvisionTemporaryAccountYardInput,
	"consent" | "consentLedger" | "maxProofOfWork" | "requestTimeoutMs"
> & {
	readonly idempotencyKey: string;
	readonly registry: TemporaryAccountRegistryPort;
	/** The already-recorded consent for the ambiguous attempt. */
	readonly consentEvidenceRef: string;
	/** Out-of-band re-read of provisioning state for this idempotency key. */
	readonly observe: () => Promise<TemporaryAccountObservation>;
};

/**
 * Resolve an ambiguous create.
 *
 * A blind retry after a timeout is how anonymous provisioning turns into
 * account spam, so adoption is the only sanctioned recovery: observe first, and
 * only mint a receipt for something that actually exists.
 */
export async function observeAndAdoptTemporaryAccount(
	input: ObserveAndAdoptInput,
): Promise<
	| {
			readonly outcome: "adopted";
			readonly receipt: TemporaryAccountYardReceipt;
	  }
	| { readonly outcome: "not-created" }
> {
	const existing = await input.registry.findReceipt(input.idempotencyKey);
	if (existing !== undefined) return { outcome: "adopted", receipt: existing };

	const attempt = await input.registry.findAttempt(input.idempotencyKey);
	if (attempt === undefined) {
		throw new TemporaryAccountError(
			"PROVIDER_OPERATION_AMBIGUOUS",
			"no recorded provisioning attempt for this idempotency key; nothing to adopt",
			{ reason: "NO_ATTEMPT" },
		);
	}

	const observation = await input.observe();
	if (observation.outcome === "not-created") {
		await input.registry.clearAttempt(input.idempotencyKey);
		return { outcome: "not-created" };
	}

	const receipt = await captureAccount(
		parsePreviewAccountResponse(observation.result),
		input,
		input.consentEvidenceRef,
		input.idempotencyKey,
		true,
	);
	await input.registry.putReceipt(receipt);
	await input.registry.clearAttempt(input.idempotencyKey);
	return { outcome: "adopted", receipt };
}
