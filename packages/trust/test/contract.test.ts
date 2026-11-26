/**
 * Provider verification for the recipe-compiler ↔ trust-gate boundary.
 *
 * The pact file records what the compiler expects when it asks whether a
 * product may be selected. This test runs the real gate for each interaction:
 * no HTTP is involved, and nothing here re-implements the gate — it is the
 * same functions, driven by the recorded requests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	applyOperatorOverride,
	computeEvidenceDigest,
	DEFAULT_TRUST_REQUIREMENT,
	type EvidenceVerifier,
	evaluateTrust,
	evaluateTrustBundle,
	parseTrustEvidence,
	type TrustEvidence,
	type TrustEvidenceInput,
	type TrustReasonCode,
	type TrustRequirement,
} from "../src/index.js";

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [k: string]: Json };

type Interaction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body: {
			readonly productDefinitionId?: string;
			readonly evidence?: string;
			readonly requirement?: string;
			readonly verifier?: string;
			readonly waivedCodes?: readonly string[];
			readonly subjects?: readonly {
				readonly subjectId: string;
				readonly evidence: string;
			}[];
		};
	};
	readonly response: { readonly status: number; readonly body: Json };
};

type Pact = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly Interaction[];
};

const PACT: Pact = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"contracts",
			"pacts",
			"trust-gate.pact.json",
		),
		"utf8",
	),
) as Pact;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 8);

const TRUST_ROOT: EvidenceVerifier = {
	id: "test.trust-root/v1",
	verify: () => "valid",
};

function evidenceInput(
	productDefinitionId: string,
	overrides: Partial<TrustEvidenceInput> = {},
): TrustEvidenceInput {
	const draft: TrustEvidenceInput = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: productDefinitionId.split(".")[0] ?? "cloudflare",
		productDefinitionId,
		adapterVersion: "0.3.1",
		providerClass: "established",
		testedAt: NOW - 7 * DAY,
		expiresAt: NOW + 23 * DAY,
		checks: {
			"bootstrap.official-contract": "pass",
			"claim.documented-contract": "pass",
			"conformance.suite": "pass",
		},
		creatorAuthorityAfterClaim: "rotatable",
		claimActionCount: 1,
		realizations: ["native"],
		sponsorBacked: false,
		evidenceDigest:
			"sha256:0000000000000000000000000000000000000000000000000000000000000000",
		signature: "sig:test",
		sourceRefs: [
			{
				url: "https://developers.cloudflare.com/workers/",
				checkedAt: "2026-08-08",
			},
		],
		...overrides,
	};
	return { ...draft, evidenceDigest: computeEvidenceDigest(draft) };
}

/** The evidence shapes the pact names, built from one honest fixture. */
function evidenceFor(
	kind: string | undefined,
	productDefinitionId: string,
): TrustEvidence | undefined {
	if (kind === "absent") return undefined;
	if (kind === "signed-fresh")
		return parseTrustEvidence(evidenceInput(productDefinitionId));
	if (kind === "expired")
		return parseTrustEvidence(
			evidenceInput(productDefinitionId, { expiresAt: NOW - 1 }),
		);
	if (kind === "expired-experimental")
		return parseTrustEvidence(
			evidenceInput(productDefinitionId, {
				expiresAt: NOW - 1,
				providerClass: "experimental",
			}),
		);
	if (kind === "unknown-check")
		return parseTrustEvidence(
			evidenceInput(productDefinitionId, {
				checks: {
					"bootstrap.official-contract": "pass",
					"claim.documented-contract": "pass",
					"conformance.suite": "unknown",
				},
			}),
		);
	throw new Error(`the pact names an unknown evidence shape ${String(kind)}`);
}

function requirementFor(name: string | undefined): TrustRequirement {
	if (name === "default" || name === undefined)
		return DEFAULT_TRUST_REQUIREMENT;
	throw new Error(`the pact names an unknown requirement ${name}`);
}

function verifierFor(name: string | undefined): EvidenceVerifier | undefined {
	if (name === "trust-root") return TRUST_ROOT;
	if (name === "none") return undefined;
	throw new Error(`the pact names an unknown verifier ${String(name)}`);
}

/** `sha256:*` is a shape assertion; everything else is exact. */
function matches(expected: Json, actual: unknown, path: string): void {
	if (typeof expected === "string" && expected.endsWith("*")) {
		expect(String(actual), path).toMatch(
			new RegExp(
				`^${expected.slice(0, -1).replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}`,
				"u",
			),
		);
		return;
	}
	if (Array.isArray(expected)) {
		expect(Array.isArray(actual), path).toBe(true);
		const rows = actual as readonly unknown[];
		expect(rows.length, path).toBe(expected.length);
		expected.forEach((entry, index) => {
			matches(entry, rows[index], `${path}[${index}]`);
		});
		return;
	}
	if (expected !== null && typeof expected === "object") {
		const record = expected as { readonly [k: string]: Json };
		for (const key of Object.keys(record)) {
			matches(
				record[key] as Json,
				(actual as { readonly [k: string]: unknown })[key],
				`${path}.${key}`,
			);
		}
		return;
	}
	expect(actual, path).toEqual(expected);
}

function respond(interaction: Interaction): {
	readonly status: number;
	readonly body: unknown;
} {
	const { path, body } = interaction.request;
	const requirement = requirementFor(body.requirement);
	const verifier = verifierFor(body.verifier);

	if (path === "/trust/bundle") {
		const bundle = evaluateTrustBundle({
			subjects: (body.subjects ?? []).map((subject) => ({
				subjectId: subject.subjectId,
				evidence: evidenceFor(subject.evidence, subject.subjectId),
			})),
			requirement,
			nowMs: NOW,
			...(verifier !== undefined ? { verifier } : {}),
		});
		return {
			status: bundle.selectable ? 200 : 409,
			body: {
				selectable: bundle.selectable,
				subjects: bundle.subjects.map((entry) => ({
					subjectId: entry.subjectId,
					selectable: entry.verdict.selectable,
					freshness: entry.freshness.state,
				})),
				reasons: bundle.reasons.map((reason) => ({
					subjectId: reason.subjectId,
					code: reason.code,
				})),
				bundleDigest: bundle.bundleDigest,
			},
		};
	}

	const productDefinitionId = body.productDefinitionId ?? "";
	const verdict = evaluateTrust(
		evidenceFor(body.evidence, productDefinitionId),
		requirement,
		NOW,
		verifier,
	);

	if (path === "/trust/evaluate") {
		return {
			status: verdict.selectable ? 200 : 409,
			body: {
				selectable: verdict.selectable,
				signatureOutcome: verdict.signatureOutcome,
				reasonCodes: [...new Set(verdict.reasons.map((reason) => reason.code))],
				verdictDigest: verdict.verdictDigest,
			},
		};
	}

	if (path === "/trust/override") {
		const overridden = applyOperatorOverride(verdict, {
			schemaVersion: "hobo.trust-override/v1",
			operatorId: "operator/contract-test",
			reason: "accepted for the recorded contract interaction",
			grantedAtMs: NOW - 1000,
			expiresAtMs: NOW + 7 * DAY,
			waivedCodes: (body.waivedCodes ?? []) as readonly TrustReasonCode[],
		});
		return {
			status: overridden.manuallyAuthorized ? 200 : 409,
			body: {
				selectable: overridden.selectable,
				manuallyAuthorized: overridden.manuallyAuthorized,
				active: overridden.override.active,
				unwaivedCodes: [...overridden.override.unwaivedCodes],
				recordDigest: overridden.override.recordDigest,
			},
		};
	}

	throw new Error(`the pact names an unknown path ${path}`);
}

describe(`${PACT.consumer.name} → ${PACT.provider.name}`, () => {
	for (const interaction of PACT.interactions) {
		it(interaction.description, () => {
			const actual = respond(interaction);
			expect(actual.status).toBe(interaction.response.status);
			matches(interaction.response.body, actual.body, "body");
		});
	}
});
