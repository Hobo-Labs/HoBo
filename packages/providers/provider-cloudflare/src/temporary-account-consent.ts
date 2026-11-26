/**
 * Consent evidence for anonymous Cloudflare account creation.
 *
 * Cloudflare requires the user to accept its Terms of Service and Privacy
 * Policy before `acceptTermsOfService` may be sent. HoBo treats that as a
 * recorded fact, not a constant in a request body: the evidence is persisted to
 * a ledger *before* the provisioning call, and a missing or malformed
 * acceptance fails closed with `CONSENT_REQUIRED`.
 */
import { TemporaryAccountError } from "./temporary-account-errors.js";

// public-contract: terms URL presented before temporary-account creation.
export const CLOUDFLARE_TERMS_URL = "https://www.cloudflare.com/terms/";
// public-contract: privacy URL presented before temporary-account creation.
export const CLOUDFLARE_PRIVACY_URL =
	"https://www.cloudflare.com/privacypolicy/";

export const CONSENT_ACCEPTANCE_METHODS = [
	"explicit-checkbox",
	"cli-confirmation",
	"api-attestation",
] as const;

export type ConsentAcceptanceMethod =
	(typeof CONSENT_ACCEPTANCE_METHODS)[number];

export type ConsentEvidenceInput = {
	/** Opaque reference to whoever accepted. Never a name, email, or IP. */
	readonly subjectRef: string;
	readonly termsUrl: string;
	readonly privacyUrl: string;
	readonly acceptedAtMs: number;
	readonly acceptanceMethod: string;
};

export type ConsentEvidence = Omit<ConsentEvidenceInput, "acceptanceMethod"> & {
	readonly acceptanceMethod: ConsentAcceptanceMethod;
};

export type ConsentRecord = ConsentEvidence & {
	/** Ledger-assigned locator. This is what a receipt is allowed to carry. */
	readonly evidenceRef: string;
	readonly recordedAtMs: number;
};

export type ConsentLedgerPort = {
	record(evidence: ConsentEvidence): Promise<ConsentRecord>;
	find(evidenceRef: string): Promise<ConsentRecord | undefined>;
};

const SUBJECT_REF = /^[A-Za-z0-9._:-]{4,128}$/u;
const EMAIL_PATTERN = /@/u;

/**
 * Parse-don't-validate boundary for consent. Downstream code takes a
 * {@link ConsentEvidence} and never re-checks the acceptance flags.
 */
export function parseConsentEvidence(
	input: ConsentEvidenceInput | undefined,
): ConsentEvidence {
	if (input === undefined) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			"Cloudflare temporary-account creation requires recorded acceptance of the Terms of Service and Privacy Policy",
			{ reason: "MISSING" },
		);
	}
	if (!SUBJECT_REF.test(input.subjectRef)) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			"consent subjectRef must be an opaque 4-128 character reference",
			{ reason: "INVALID_SUBJECT" },
		);
	}
	if (EMAIL_PATTERN.test(input.subjectRef)) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			"consent subjectRef must be an opaque reference, not a contact identifier",
			{ reason: "SUBJECT_LOOKS_LIKE_PII" },
		);
	}
	if (input.termsUrl !== CLOUDFLARE_TERMS_URL) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			`consent must reference ${CLOUDFLARE_TERMS_URL}`,
			{ reason: "WRONG_TERMS_URL" },
		);
	}
	if (input.privacyUrl !== CLOUDFLARE_PRIVACY_URL) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			`consent must reference ${CLOUDFLARE_PRIVACY_URL}`,
			{ reason: "WRONG_PRIVACY_URL" },
		);
	}
	if (!Number.isInteger(input.acceptedAtMs) || input.acceptedAtMs <= 0) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			"consent acceptedAtMs must be a positive epoch-millisecond integer",
			{ reason: "INVALID_TIMESTAMP" },
		);
	}
	if (
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		!(CONSENT_ACCEPTANCE_METHODS as readonly string[]).includes(
			input.acceptanceMethod,
		)
	) {
		throw new TemporaryAccountError(
			"CONSENT_REQUIRED",
			`consent acceptanceMethod must be one of ${CONSENT_ACCEPTANCE_METHODS.join(", ")}`,
			{ reason: "INVALID_METHOD" },
		);
	}
	return {
		subjectRef: input.subjectRef,
		termsUrl: input.termsUrl,
		privacyUrl: input.privacyUrl,
		acceptedAtMs: input.acceptedAtMs,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		acceptanceMethod: input.acceptanceMethod as ConsentAcceptanceMethod,
	};
}

/**
 * Reference ledger. Production deployments swap in a durable implementation;
 * the port is what the provisioning flow depends on.
 */
export function createInMemoryConsentLedger(options?: {
	readonly nowMs?: () => number;
	readonly nextId?: () => string;
}): ConsentLedgerPort & { list(): readonly ConsentRecord[] } {
	const records = new Map<string, ConsentRecord>();
	let counter = 0;
	const nowMs = options?.nowMs ?? (() => Date.now());
	const nextId =
		options?.nextId ??
		(() => {
			counter += 1;
			return `consent-${String(counter).padStart(6, "0")}`;
		});

	return {
		async record(evidence) {
			const evidenceRef = `hobo-consent://cloudflare-temporary/${nextId()}`;
			const stored: ConsentRecord = {
				...evidence,
				evidenceRef,
				recordedAtMs: nowMs(),
			};
			records.set(evidenceRef, stored);
			return stored;
		},
		async find(evidenceRef) {
			return records.get(evidenceRef);
		},
		list() {
			return [...records.values()];
		},
	};
}
