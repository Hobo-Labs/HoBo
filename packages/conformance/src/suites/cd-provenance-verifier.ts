// ProvenanceVerifier conformance (plan 0024 D3, I15). in-toto v1 + SLSA
// provenance, verified as a signed bundle, bound to the subjects' digests and
// pinned to trusted builders and signers. Fail closed on everything else.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	checkTypedRefusal,
	runCdAssertions,
} from "./cd-kit.js";
import type {
	Outcome,
	ProvenanceInputLike,
	ProvenanceRefLike,
	ProvenanceVerifierLike,
} from "./cd-shapes.js";

export const PROVENANCE_VERIFIER_SUITE = "hobo.cd.provenance-verifier/v1";

// public-contract: assertion names of the ProvenanceVerifier suite.
export const PROVENANCE_VERIFIER_ASSERTIONS = Object.freeze([
	"validAttestationIsVerified",
	"tamperedSubjectIsRefused",
	"untrustedBuilderIsRefused",
	"untrustedSignerIsRefused",
	"unsignedStatementIsRefused",
	"malformedStatementIsRefusedNotThrown",
	"verificationIsDeterministic",
	"resultsAreSecretFree",
] as const);
export type ProvenanceVerifierAssertion =
	(typeof PROVENANCE_VERIFIER_ASSERTIONS)[number];

/** Inputs the harness signs with its own test trust root. */
export type ProvenanceCases = Readonly<{
	valid: ProvenanceInputLike;
	/** The statement's subject digest differs from the artifact digest. */
	tamperedSubject: ProvenanceInputLike;
	/** Valid signature; the builder id is not in trustedBuilderIds. */
	untrustedBuilder: ProvenanceInputLike;
	/** Valid signature by an identity not in trustedSignerIdentities. */
	untrustedSigner: ProvenanceInputLike;
	/** Signer identities are pinned but no bundle is supplied. */
	unsigned: ProvenanceInputLike;
	/** Bytes that are not an in-toto Statement. */
	malformed: ProvenanceInputLike;
}>;

export interface ProvenanceVerifierHarness<TCtx> {
	readonly subject: string;
	create(): Promise<ProvenanceVerifierLike<TCtx>>;
	cases(): ProvenanceCases;
	ctx(): TCtx;
}

export async function runProvenanceVerifierConformance<TCtx>(
	harness: ProvenanceVerifierHarness<TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<ProvenanceVerifierAssertion>> {
	const run = async (
		pick: keyof ProvenanceCases,
	): Promise<Outcome<readonly ProvenanceRefLike[]>> => {
		const verifier = await harness.create();
		try {
			return await verifier.verify(harness.cases()[pick], harness.ctx());
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			check(
				false,
				`verify threw on the ${pick} case: ${detail}`,
				"return a typed refusal; never throw across the port",
			);
			throw error;
		}
	};
	return runCdAssertions<ProvenanceVerifierAssertion>(
		PROVENANCE_VERIFIER_SUITE,
		harness.subject,
		{
			validAttestationIsVerified: async () => {
				const outcome = await run("valid");
				check(
					outcome.ok,
					"a valid signed attestation was refused",
					"verify the bundle against the trust root",
				);
				if (!outcome.ok) return;
				const input = harness.cases().valid;
				check(
					outcome.value.length > 0,
					"no ProvenanceRef returned",
					"return one ref per verified statement",
				);
				for (const ref of outcome.value) {
					check(
						ref.verified,
						"a returned ref is not marked verified",
						"return only verified refs",
					);
					check(
						input.trustedBuilderIds.includes(ref.builderId),
						`builder ${ref.builderId} is not trusted`,
						"pin builder ids",
					);
					for (const subject of input.subjects) {
						check(
							ref.subjectDigests.includes(subject.digest),
							`subject ${subject.digest} is not bound`,
							"bind the statement to every subject digest",
						);
					}
				}
			},
			tamperedSubjectIsRefused: async () =>
				checkTypedRefusal(
					await run("tamperedSubject"),
					"an attestation for other bytes",
				),
			untrustedBuilderIsRefused: async () =>
				checkTypedRefusal(
					await run("untrustedBuilder"),
					"an attestation from an untrusted builder",
				),
			untrustedSignerIsRefused: async () =>
				checkTypedRefusal(
					await run("untrustedSigner"),
					"an attestation signed by an untrusted identity",
				),
			unsignedStatementIsRefused: async () =>
				checkTypedRefusal(
					await run("unsigned"),
					"an unsigned statement where signers are pinned",
				),
			malformedStatementIsRefusedNotThrown: async () =>
				checkTypedRefusal(await run("malformed"), "a malformed statement"),
			verificationIsDeterministic: async () => {
				const a = await run("valid");
				const b = await run("valid");
				check(
					a.ok === b.ok,
					"two verifications of one attestation disagree",
					"verification is deterministic (I8)",
				);
			},
			resultsAreSecretFree: async () => {
				checkSecretFree(await run("valid"), "the verified refs");
				checkSecretFree(await run("untrustedSigner"), "the refusal");
			},
		},
		options,
	);
}
