// DPoP verification bound to the replay store, ported from the delivery
// stack's `packages/cd/src/agent/dpop-verifier.ts`: signature and claims first
// (./dpop.ts), then the `jti` is claimed once per key through `ReplayStore`.
//
// Adapted: the replay scope is the proof key's thumbprint (the delivery stack
// scoped by reconciler id, which a fleet verifier does not know before the
// proof is checked), and a jti is remembered until the proof can no longer
// pass the ±60 s `iat` window.
import type { Outcome, ReplayStore } from "../ports.js";
import {
	DPOP_SKEW_MS,
	type DpopExpectation,
	type VerifiedDpop,
	verifyDpopClaims,
} from "./dpop.js";
import { refuse } from "./jose.js";

/** The `ReplayStore` scope of a DPoP `jti`: one per proof key. */
export function dpopReplayScope(jkt: string): string {
	return `dpop:${jkt}`;
}

export async function verifyDpopWithReplay(
	proof: string,
	expect: DpopExpectation,
	replay: ReplayStore,
): Promise<Outcome<VerifiedDpop>> {
	const verified = verifyDpopClaims(proof, expect);
	if (!verified.ok) return verified;
	try {
		const first = await replay.firstUse(
			dpopReplayScope(verified.value.jkt),
			verified.value.jti,
			verified.value.iatSeconds * 1000 + DPOP_SKEW_MS,
		);
		if (!first)
			return refuse(
				"proof-replayed",
				`DPoP jti ${verified.value.jti} was already used`,
			);
	} catch (error) {
		return refuse(
			"unavailable",
			error instanceof Error ? error.message : "the replay store failed",
		);
	}
	return verified;
}
