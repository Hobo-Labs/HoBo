/**
 * The ephemeral-Camp lane gate (ADR-0159 §2b).
 *
 * A Camp is provider-neutral until it is attached to a Yard, so this lane
 * cannot be inferred: it needs an explicit Yard *and* brokered credentials.
 * Both are checked here, in order, and each missing piece refuses with its own
 * code and remediation. The one behaviour this module must never exhibit is a
 * quiet downgrade to `in-process` — a suite that thinks it hit real providers
 * and actually hit a loopback stub is worse than a suite that failed.
 *
 * Credentials are located, never carried: the environment variable names a
 * `secretRef` locator (ADR-0113). A raw-looking value is refused rather than
 * used, because a pasted token in a test environment is exactly the CI secret
 * habit ADR-0159 §4 exists to end.
 */

import { TestHarnessError } from "./../errors.js";

/** Environment contract: names the brokered credential, never carries it. */
export const CAMP_CREDENTIAL_ENV_VAR = "HOBO_TESTING_CAMP_CREDENTIAL_REF"; // public-contract: env-var name the camp lane brokers credentials through

const SECRET_REF_PATTERN =
	/^(?:vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token):\/\/[^@\s]+$/u;

export interface EphemeralCampTarget {
	readonly yardName: string;
	readonly providerId: string;
	readonly credentialRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse boundary for the lane's preconditions. Returns a frozen derived
 * domain type or throws; there is no partially-satisfied result.
 */
export function parseEphemeralCampTarget(
	yard: unknown,
	env: Readonly<Record<string, string | undefined>> = process.env,
): EphemeralCampTarget {
	if (yard === undefined || yard === null) {
		throw new TestHarnessError(
			"HARNESS_YARD_REQUIRED",
			"the ephemeral-camp lane was selected without a Yard",
			"pass an explicit Yard — createTestHarness({ lane: 'ephemeral-camp', yard }) — the lane never falls back to in-process",
		);
	}
	if (
		!isRecord(yard) ||
		typeof yard.name !== "string" ||
		yard.name.length === 0 ||
		typeof yard.providerId !== "string" ||
		yard.providerId.length === 0
	) {
		throw new TestHarnessError(
			"HARNESS_YARD_INVALID",
			"the supplied `yard` is not a parsed Yard (no `name`/`providerId`)",
			"build it with `yard(name, { provider })` from @hobo/yards and pass the returned value unchanged",
		);
	}

	const credentialRef = env[CAMP_CREDENTIAL_ENV_VAR];
	if (credentialRef === undefined || credentialRef.length === 0) {
		throw new TestHarnessError(
			"HARNESS_CREDENTIALS_REQUIRED",
			`the ephemeral-camp lane needs brokered credentials; ${CAMP_CREDENTIAL_ENV_VAR} is not set`,
			`set ${CAMP_CREDENTIAL_ENV_VAR} to a brokered secretRef locator (for example hobo-secret://tenant/yard/deploy) — the lane never degrades to in-process`,
		);
	}
	if (!SECRET_REF_PATTERN.test(credentialRef)) {
		throw new TestHarnessError(
			"HARNESS_CREDENTIAL_NOT_A_REF",
			`${CAMP_CREDENTIAL_ENV_VAR} does not hold a secretRef locator`,
			"broker the credential and reference it (vault://, aws-sm://, hobo-secret://, …); a pasted token value is refused by design (ADR-0113)",
		);
	}

	return Object.freeze({
		yardName: yard.name,
		providerId: yard.providerId,
		credentialRef,
	});
}

/**
 * HONEST SCOPE: provisioning is not implemented. The gate above is real; the
 * deploy path is declared and refused. Returning a stubbed graph here would be
 * the silent downgrade this lane exists to prevent.
 */
export async function deployEphemeralCamp(
	target: EphemeralCampTarget,
): Promise<never> {
	await Promise.resolve();
	throw new TestHarnessError(
		"HARNESS_LANE_UNIMPLEMENTED",
		`the ephemeral-camp lane cannot yet provision Camps on yard "${target.yardName}" (provider ${target.providerId}); its gates are implemented, its provisioning is not`,
		"use the in-process lane and read its fidelity report, or deploy the stage Camp with the CLI and point the suite at it — this refusal is deliberate, not a transient failure",
	);
}
