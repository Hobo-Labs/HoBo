/**
 * Contract-asserted dual fixtures for continuous identity migration (ADR-0070 extension).
 * Offline `hobo dev` / tests exercise source, target, and dual paths without real IdPs.
 */

import type { AdapterClaims } from "./dual-adapter.js";
import {
	applyClaimTransform,
	defaultContinuousMappingSpec,
	type MappingSpec,
} from "./mapping-spec.js";

// public-contract: dual fixture fidelity labels.
export const DUAL_FIXTURE_FIDELITY = Object.freeze({
	source: "simulated",
	target: "simulated",
	dual: "simulated",
} as const);

export type DualIdentityFixtures = Readonly<{
	tenant: string;
	sourceAdapter: string;
	targetAdapter: string;
	mapping: MappingSpec;
	/** Contract-asserted source principal claims. */
	sourceClaims: AdapterClaims;
	/** Contract-asserted target principal claims (dual-consistent). */
	targetClaims: AdapterClaims;
	/** Intentionally divergent claims for fail-closed oracle tests. */
	divergentTargetClaims: AdapterClaims;
	principalRef: string;
	fidelity: typeof DUAL_FIXTURE_FIDELITY;
	/** Honest label: dual path is simulated offline. */
	label: "contract-asserted-dual-fixtures";
}>;

/**
 * Build dual fixtures matching the same contracts as production dual-verify.
 */
export function createContractAssertedDualFixtures(input?: {
	readonly tenant?: string;
	readonly sourceAdapter?: string;
	readonly targetAdapter?: string;
	readonly subject?: string;
	readonly email?: string;
}): DualIdentityFixtures {
	const tenant = input?.tenant ?? "tenant-dev";
	const sourceAdapter = input?.sourceAdapter ?? "fixture-oidc-source";
	const targetAdapter = input?.targetAdapter ?? "fixture-oidc-target";
	const subject = input?.subject ?? "user-alice-1";
	const email = input?.email ?? "alice@example.test";

	const mapping = defaultContinuousMappingSpec({
		sourceAdapter,
		targetAdapter,
	});

	const sourceClaims = Object.freeze({
		sub: subject,
		tenant,
		email,
	});
	const targetClaims = Object.freeze({
		sub: subject,
		tenant,
		email,
	});
	const divergentTargetClaims = Object.freeze({
		sub: `${subject}-DIVERGED`,
		tenant,
		email: "other@example.test",
	});

	// principal-ref transform of subject under tenant (matches dualVerifyClaims).
	const principalRef = `principal:${tenant}:${applyClaimTransform(subject, "principal-ref")}`;

	return Object.freeze({
		tenant,
		sourceAdapter,
		targetAdapter,
		mapping,
		sourceClaims,
		targetClaims,
		divergentTargetClaims,
		principalRef,
		fidelity: DUAL_FIXTURE_FIDELITY,
		label: "contract-asserted-dual-fixtures",
	});
}
