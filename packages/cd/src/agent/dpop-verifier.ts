// DPoP verification bound to the replay store: signature and claims first
// (./dpop.ts), then the `jti` is claimed once per reconciler (./replay.ts).
import type { Outcome } from "../ports.js";
import {
	type DpopExpectation,
	type VerifiedDpop,
	verifyDpopProof,
} from "./dpop.js";
import { agentRefusal, messageOf } from "./errors.js";
import type { DpopReplayStore } from "./replay.js";

export type DpopCheck = Readonly<{
	reconcilerId: string;
	method: string;
	url: string;
	nowMs: number;
	accessToken?: string;
}>;

export interface DpopProofVerifier {
	verify(proof: string, check: DpopCheck): Promise<Outcome<VerifiedDpop>>;
}

export function createDpopProofVerifier(
	d: Readonly<{
		replay: DpopReplayStore;
		skewMs: number;
		publicOrigin?: string;
	}>,
): DpopProofVerifier {
	return Object.freeze({
		async verify(
			proof: string,
			check: DpopCheck,
		): Promise<Outcome<VerifiedDpop>> {
			const url =
				d.publicOrigin && check.url.startsWith("/")
					? `${d.publicOrigin}${check.url}`
					: check.url;
			const base = {
				method: check.method,
				url,
				nowMs: check.nowMs,
				skewMs: d.skewMs,
			};
			const expectation: DpopExpectation =
				check.accessToken === undefined
					? base
					: { ...base, accessToken: check.accessToken };
			const verified = verifyDpopProof(proof, expectation);
			if (!verified.ok) return verified;
			try {
				const first = await d.replay.claim({
					reconcilerId: check.reconcilerId,
					jti: verified.value.jti,
					iatSeconds: verified.value.iatSeconds,
				});
				if (!first)
					return agentRefusal(
						"dpop-replayed",
						`DPoP jti ${verified.value.jti} was already used`,
						check.reconcilerId,
					);
			} catch (error) {
				return agentRefusal(
					"store-unavailable",
					messageOf(error),
					check.reconcilerId,
				);
			}
			return verified;
		},
	} satisfies DpopProofVerifier);
}
