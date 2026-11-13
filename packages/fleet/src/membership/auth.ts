/**
 * `authenticate` (L02 private): the four `VerifiedToken` kinds.
 *
 * - `Authorization: DPoP <jwt>`: a member SVID or a person token, verified by
 *   the authority's own `CredentialIssuer` (a self-minted token never
 *   verifies), with a DPoP proof over this method and URL, `ath` of the token,
 *   a fresh `jti`, and the proof key equal to the token's `cnf.jkt`. A member
 *   token is refused at once when the member is no longer ACTIVE.
 * - `Authorization: Bearer <credential>`: the relay's account credential, else
 *   a workload OIDC token (audience: the authority's issuer).
 * - No `Authorization`, only a DPoP proof made with an enrolled device's SIGN
 *   key: the device itself (`credentials` before it holds an SVID). The token
 *   lives as long as the proof's window.
 */

import { verifyDpopProof } from "../keys/index.js";
import type { Outcome, VerifiedToken } from "../ports.js";
import { decodeBundle, signThumbprint } from "./bundle.js";
import { type Ctx, refuse, stateRefusal } from "./context.js";
import { isJsonNumber } from "./json.js";

const PROOF_WINDOW_MS = 60_000;
const WORKLOAD_DEFAULT_MS = 5 * 60 * 1_000;

export async function authenticate(
	ctx: Ctx,
	request: Readonly<{
		method: string;
		url: string;
		authorization: string;
		dpop: string;
	}>,
): Promise<Outcome<VerifiedToken>> {
	const { deps } = ctx;
	const header = request.authorization.trim();
	const space = header.indexOf(" ");
	const scheme = space < 0 ? header : header.slice(0, space);
	const credential = space < 0 ? "" : header.slice(space + 1).trim();

	if (scheme.toLowerCase() === "dpop" && credential.length > 0) {
		const token = deps.issuer.verify(
			credential,
			deps.discovery.issuer,
			deps.now(),
		);
		if (!token.ok) return refuse("unauthenticated", token.error.message);
		if (token.value.tenant !== deps.tenant)
			return refuse("unauthenticated", "the token is for another tenant");
		if (request.dpop.length === 0)
			return refuse("proof-invalid", "a DPoP-bound token needs a DPoP proof");
		const proof = await verifyDpopProof({
			proof: request.dpop,
			htm: request.method,
			htu: request.url,
			accessToken: credential,
			nowMs: deps.now(),
			replay: deps.bus.replay,
		});
		if (!proof.ok) return proof;
		if (
			(token.value.kind !== "member" && token.value.kind !== "person") ||
			proof.value.jkt !== token.value.jkt
		)
			return refuse("proof-invalid", "the proof key is not the token's key");
		if (token.value.kind === "member") {
			const state = (await ctx.catchUp()).members.get(token.value.memberId);
			if (state === undefined)
				return refuse("unauthenticated", "the token names an unknown member");
			const refusal = stateRefusal<VerifiedToken>(state.record);
			if (refusal !== undefined) return refusal;
		}
		return token;
	}

	if (scheme.toLowerCase() === "bearer" && credential.length > 0) {
		const account = await safely(() => deps.accounts.verify(credential));
		if (account?.ok)
			return {
				ok: true,
				value: {
					kind: "account",
					principal: account.value.principal,
					tenant: account.value.tenant,
					scopes: account.value.scopes,
				},
			};
		const workload = await safely(() =>
			deps.assertions.verifyOidc(credential, deps.discovery.issuer),
		);
		if (workload?.ok) {
			const exp = Number(workload.value.claims.exp);
			return {
				ok: true,
				value: {
					kind: "workload",
					issuer: workload.value.issuer,
					subject: workload.value.subject,
					repository: workload.value.claims.repository ?? "",
					tenant: deps.tenant,
					expiresAtMs:
						isJsonNumber(exp) && Number.isFinite(exp) && exp > 0
							? exp * 1_000
							: deps.now() + WORKLOAD_DEFAULT_MS,
				},
			};
		}
		return refuse("unauthenticated", "the bearer credential does not verify");
	}

	if (header.length === 0 && request.dpop.length > 0) {
		const proof = await verifyDpopProof({
			proof: request.dpop,
			htm: request.method,
			htu: request.url,
			nowMs: deps.now(),
			replay: deps.bus.replay,
		});
		if (!proof.ok) return proof;
		for (const [memberId, state] of (await ctx.catchUp()).members) {
			if (
				signThumbprint(decodeBundle(state.record.keyBundle)) !== proof.value.jkt
			)
				continue;
			return {
				ok: true,
				value: {
					kind: "member",
					memberId,
					tenant: deps.tenant,
					jkt: proof.value.jkt,
					expiresAtMs: deps.now() + PROOF_WINDOW_MS,
				},
			};
		}
		return refuse(
			"unauthenticated",
			"the proof key is not an enrolled SIGN key",
		);
	}
	return refuse("unauthenticated", "no credential");
}

async function safely<T>(run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch {
		return undefined;
	}
}
