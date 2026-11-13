/**
 * `authenticate` (L02 private): the four `VerifiedToken` kinds.
 *
 * - `Authorization: DPoP <jwt>`: a member SVID or a person token, verified by
 *   the authority's own `CredentialIssuer` (a self-minted token never
 *   verifies), with a DPoP proof over this method and URL, `ath` of the token,
 *   a fresh `jti`, and the proof key equal to the token's `cnf.jkt`. A member
 *   token is refused at once when the member is no longer ACTIVE. A token
 *   minted under an earlier authority incarnation is `incarnation-stale`: by
 *   its `incarnation` claim when it carries one (L09's tokens do), else by
 *   its `iat` against when the current incarnation began (L41). The
 *   issuer's own `incarnation-stale` is passed through as it is (L42).
 * - `Authorization: Bearer <credential>`: the relay's account credential, else
 *   a workload OIDC token (audience: the authority's issuer).
 * - No `Authorization`, only a DPoP proof made with an enrolled device's SIGN
 *   key: the device itself (`credentials` before it holds an SVID). The token
 *   lives as long as the proof's window.
 */

import type { JsonValue } from "@hobo/core";
import { verifyDpopProof } from "../keys/index.js";
import type { Outcome, VerifiedToken } from "../ports.js";
import { decodeBundle, signThumbprint } from "./bundle.js";
import { type Ctx, refuse, stateRefusal } from "./context.js";
import { isJsonNumber, isJsonObject } from "./json.js";

/** When and under which incarnation a token was minted, as far as its claims say. */
type Minted = Readonly<{
	/** `iat`, epoch ms. */
	atMs: number | undefined;
	/** The `incarnation` claim, when the token carries one. */
	incarnation: number | undefined;
}>;

/**
 * What `authenticate` read from each token it verified, keyed by the
 * `VerifiedToken` it answered, so `credentials` can apply the incarnation
 * rule again to the caller it is handed (`VerifiedToken` has no issue time
 * or incarnation of its own, and widening it would change a frozen contract).
 */
const mintedOf = new WeakMap<VerifiedToken, Minted>();

const finite = (value: JsonValue | undefined): number | undefined =>
	isJsonNumber(value) && Number.isFinite(value) ? value : undefined;

/** The `iat` and `incarnation` claims of a compact JWT the issuer has already verified. */
function mintedClaims(jwt: string): Minted {
	const payload = jwt.split(".")[1];
	if (payload === undefined) return { atMs: undefined, incarnation: undefined };
	try {
		const claims: JsonValue = JSON.parse(
			Buffer.from(payload, "base64url").toString(),
		);
		if (!isJsonObject(claims))
			return { atMs: undefined, incarnation: undefined };
		const iat = finite(claims.iat);
		return {
			atMs: iat === undefined ? undefined : iat * 1_000,
			incarnation: finite(claims.incarnation),
		};
	} catch {
		return { atMs: undefined, incarnation: undefined };
	}
}

const stale = <T>(ctx: Ctx): Outcome<T> =>
	refuse(
		"incarnation-stale",
		`the token was minted before authority incarnation ${ctx.deps.incarnation} began`,
	);

/**
 * `incarnation-stale` for a token minted under an earlier incarnation, else
 * undefined. A token's `incarnation` claim decides when it carries one;
 * otherwise `incarnationRefusal` applies the `iat` rule.
 */
async function mintedRefusal<T>(
	ctx: Ctx,
	minted: Minted,
): Promise<Outcome<T> | undefined> {
	if (minted.incarnation !== undefined)
		return minted.incarnation < ctx.deps.incarnation
			? stale<T>(ctx)
			: undefined;
	return incarnationRefusal<T>(ctx, minted.atMs);
}

/**
 * `incarnation-stale` for a token minted before the authority's current
 * incarnation began (the restore that raised it, as journalled), else
 * undefined. `iat` has one-second precision, so a token minted in the same
 * second as the restore is accepted. A token with no `iat` is stale once an
 * incarnation has begun. Before any restore nothing is stale.
 */
export async function incarnationRefusal<T>(
	ctx: Ctx,
	minted: number | undefined,
): Promise<Outcome<T> | undefined> {
	const began = (await ctx.catchUp()).incarnations.get(ctx.deps.incarnation);
	if (began === undefined) return undefined;
	if (minted !== undefined && minted >= Math.floor(began / 1_000) * 1_000)
		return undefined;
	return stale<T>(ctx);
}

/** The incarnation rule for a caller `authenticate` answered from a token; a proof-only caller holds no minted token. */
export function callerIncarnationRefusal<T>(
	ctx: Ctx,
	caller: VerifiedToken | undefined,
): Promise<Outcome<T> | undefined> {
	const minted = caller === undefined ? undefined : mintedOf.get(caller);
	if (minted === undefined) return Promise.resolve(undefined);
	return mintedRefusal<T>(ctx, minted);
}

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
		if (!token.ok)
			return token.error.code === "incarnation-stale"
				? token
				: refuse("unauthenticated", token.error.message);
		if (token.value.tenant !== deps.tenant)
			return refuse("unauthenticated", "the token is for another tenant");
		const minted = mintedClaims(credential);
		const refused = await mintedRefusal<VerifiedToken>(ctx, minted);
		if (refused !== undefined) return refused;
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
		mintedOf.set(token.value, {
			atMs: minted.atMs ?? Number.NEGATIVE_INFINITY,
			incarnation: minted.incarnation,
		});
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
