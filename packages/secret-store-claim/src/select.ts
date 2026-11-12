/**
 * The routing seam: which offer satisfies `secrets.config-service/v1` for
 * this deploy. Pure. Hard gates first (ADR-0151: gates, never scores), then
 * the policy's preference order; the evidence is what the deploy observed
 * when it ran, so the store is decided at deploy time, never pre-provisioned.
 *
 * Gates, in the order a skip reports them:
 *
 * 1. the deploy gathered evidence for the offer;
 * 2. the evidence says it is available (an auth.md store was discovered, the
 *    human accepted Cloudflare's terms, a fresh fleet host exists, the owner
 *    is signed in to Infisical);
 * 3. the relay can read the store (`runtimeBinding: "built"`), unless the
 *    caller asks for a store the relay cannot read yet.
 */
import { create } from "@bufbuild/protobuf";
import {
	type SecretStoreEvidence,
	type SecretStoreSelection,
	SecretStoreSelectionSchema,
} from "./_generated/secret_store_claim_pb.js";
import { secretStoreError } from "./errors.js";
import {
	type ParsedSecretStoreOffer,
	parseSecretStoreKind,
	SECRET_STORE_CAPABILITY,
	type SecretStoreKind,
} from "./offers.js";

/** Evidence that passed its parser. */
export type ParsedSecretStoreEvidence = Readonly<{
	kind: SecretStoreKind;
	available: boolean;
	detail: string;
}>;

export function parseSecretStoreEvidence(
	record: SecretStoreEvidence,
): ParsedSecretStoreEvidence {
	const kind = parseSecretStoreKind(record.kind);
	if (
		!/^[^\n]{0,200}$/u.test(record.detail) ||
		(!record.available && record.detail === "")
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			`evidence for ${kind} must say, in one short line, why it is unavailable`,
		);
	return Object.freeze({
		kind,
		available: record.available,
		detail: record.detail,
	});
}

export type SecretStoreRoute = Readonly<{
	offer: ParsedSecretStoreOffer;
	selection: SecretStoreSelection;
}>;

export function selectSecretStore(input: {
	readonly offers: readonly ParsedSecretStoreOffer[];
	readonly evidence: readonly ParsedSecretStoreEvidence[];
	/** Route to a store the relay cannot read yet (tests, previews of the design). */
	readonly allowDesigned?: boolean;
	readonly now: Date;
}): SecretStoreRoute {
	const preferences = new Set(input.offers.map((offer) => offer.preference));
	const kinds = new Set(input.offers.map((offer) => offer.kind));
	if (
		preferences.size !== input.offers.length ||
		kinds.size !== input.offers.length
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"each offer needs its own kind and its own preference",
		);
	const ordered = [...input.offers].sort((a, b) => a.preference - b.preference);
	const skipped: { kind: string; reason: string }[] = [];
	for (const offer of ordered) {
		const seen = input.evidence.find((entry) => entry.kind === offer.kind);
		let reason: string | undefined;
		// Secretless first: a store the relay could only read with a stored
		// token is never its runtime store; nowhere it may live is allowed.
		if (offer.runtimeAuth === "stored-token")
			reason = `the relay would need a stored ${offer.provider} token on Vercel or in GitHub, which ADR-0179 forbids; ${offer.provider} serves the owner's side only`;
		else if (seen === undefined) reason = "not probed by this deploy";
		else if (!seen.available) reason = seen.detail;
		else if (offer.runtimeBinding !== "built" && input.allowDesigned !== true)
			reason =
				"the relay cannot read this store yet (runtime binding designed, not built)";
		if (reason !== undefined) {
			skipped.push({ kind: offer.kind, reason });
			continue;
		}
		return Object.freeze({
			offer,
			selection: create(SecretStoreSelectionSchema, {
				capability: SECRET_STORE_CAPABILITY,
				selectedKind: offer.kind,
				skipped,
				decidedAt: input.now.toISOString(),
			}),
		});
	}
	return secretStoreError(
		"SECRET_STORE_NO_OFFER",
		`no offer can provide ${SECRET_STORE_CAPABILITY}: ${skipped
			.map((skip) => `${skip.kind} (${skip.reason})`)
			.join("; ")}`,
	);
}
