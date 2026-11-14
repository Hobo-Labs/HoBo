// ArtifactVerifier conformance (plan 0024 D2/D3, I1, I5). Every artifact in
// a manifest must resolve, at its coordinate, to exactly its digest. Anything
// else is a typed refusal; an unreachable coordinate never passes.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	checkTypedRefusal,
	runCdAssertions,
} from "./cd-kit.js";
import type { ArtifactVerifierLike } from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const ARTIFACT_VERIFIER_SUITE = "hobo.cd.artifact-verifier/v1";

// public-contract: assertion names of the ArtifactVerifier suite.
export const ARTIFACT_VERIFIER_ASSERTIONS = Object.freeze([
	"intactManifestIsVerified",
	"digestsAreUnchanged",
	"tamperedArtifactIsRefused",
	"unreachableCoordinateIsRefused",
	"verificationIsDeterministic",
	"refusalIsSecretFree",
] as const);
export type ArtifactVerifierAssertion =
	(typeof ARTIFACT_VERIFIER_ASSERTIONS)[number];

/** What the coordinates serve, as the harness arranges it. */
export type ArtifactWorld = "intact" | "tampered" | "unreachable";

export interface ArtifactVerifierHarness<TManifest, TCtx> {
	readonly subject: string;
	create(world: ArtifactWorld): Promise<ArtifactVerifierLike<TManifest, TCtx>>;
	manifest(): TManifest;
	/** The manifest's artifact digests, in manifest order. */
	digests(manifest: TManifest): readonly string[];
	ctx(): TCtx;
}

export async function runArtifactVerifierConformance<TManifest, TCtx>(
	harness: ArtifactVerifierHarness<TManifest, TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<ArtifactVerifierAssertion>> {
	const verify = async (world: ArtifactWorld) =>
		(await harness.create(world)).verify(harness.manifest(), harness.ctx());
	return runCdAssertions<ArtifactVerifierAssertion>(
		ARTIFACT_VERIFIER_SUITE,
		harness.subject,
		{
			intactManifestIsVerified: async () => {
				const outcome = await verify("intact");
				check(
					outcome.ok,
					"an intact manifest was refused",
					"verify each digest at its coordinate",
				);
			},
			digestsAreUnchanged: async () => {
				const outcome = await verify("intact");
				if (!outcome.ok)
					return check(
						false,
						"an intact manifest was refused",
						"verify each digest at its coordinate",
					);
				const before = harness.digests(harness.manifest()).join(",");
				const after = harness.digests(outcome.value).join(",");
				check(
					before === after,
					"verification changed artifact digests",
					"never rewrite a digest; mirrors keep digests (D22)",
				);
			},
			tamperedArtifactIsRefused: async () => {
				checkTypedRefusal(
					await verify("tampered"),
					"a manifest whose coordinate serves other bytes",
				);
			},
			unreachableCoordinateIsRefused: async () => {
				checkTypedRefusal(
					await verify("unreachable"),
					"a manifest whose coordinate is unreachable",
				);
			},
			verificationIsDeterministic: async () => {
				const a = await verify("intact");
				const b = await verify("intact");
				check(
					a.ok === b.ok,
					"two verifications of the same manifest disagree",
					"verification is deterministic (I8)",
				);
			},
			refusalIsSecretFree: async () => {
				checkSecretFree(await verify("unreachable"), "the refusal");
				checkSecretFree(await verify("tampered"), "the refusal");
			},
		},
		options,
	);
}
