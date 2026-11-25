import type { Outcome, ReplayStore } from "../ports.js";
import {
	DPOP_SKEW_MS,
	type DpopExpectation,
	type VerifiedDpop,
	verifyDpopClaims,
} from "./dpop.js";
import { refuse } from "./jose.js";

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
			return refuse("proof-replayed", "The DPoP proof was already used.");
	} catch {
		return refuse("unavailable", "The replay-protection store is unavailable.");
	}
	return verified;
}
