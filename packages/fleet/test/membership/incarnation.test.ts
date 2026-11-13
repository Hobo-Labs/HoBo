// incarnation-stale (L41): after a restore raises the authority incarnation,
// `authenticate` and `credentials` refuse an SVID or person token minted
// before the new incarnation began. The incarnation began at the `issued_at`
// of the journalled `fleet.TrustRotated` record that raised it; a token's
// `iat` before that is stale. A rotation within one incarnation stales
// nothing, and a device refreshes by its SIGN-key proof after the restore.

import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TrustRecordSchema } from "../../src/_generated/fleet_pb.js";
import { FLEET_TRUST_STREAM } from "../../src/events.js";
import { mintDpopProof } from "../../src/keys/index.js";
import { createEnrollmentAuthority } from "../../src/membership/index.js";
import type {
	CredentialIssuer,
	EnrollmentAuthority,
	Outcome,
	VerifiedToken,
} from "../../src/ports.js";
import {
	dpopFor,
	type Harness,
	harness,
	ISSUER,
	refresh,
	TENANT,
	type TestDevice,
} from "./fixtures.js";
import { active, code, value } from "./scenario.js";

/** Journals a trust record of `incarnation`, issued now, as `fleet.TrustRotated`. */
async function rotateTrust(
	h: Harness,
	incarnation: number,
	sequence: number,
): Promise<void> {
	const record = create(TrustRecordSchema, {
		tenant: TENANT,
		sequence,
		authorityIncarnation: incarnation,
		issuer: ISSUER,
		issuedAt: new Date(h.clock.now()).toISOString(),
	});
	await h.store.append(
		FLEET_TRUST_STREAM,
		[
			{
				type: "fleet.TrustRotated",
				data: {
					record: Buffer.from(toBinary(TrustRecordSchema, record)).toString(
						"base64",
					),
					sequence,
					authorityIncarnation: incarnation,
					reason: incarnation > 1 ? "restore" : "rotate:witness:publish",
				},
			},
		],
		{
			expectedSeq: sequence - 2,
			actor: { kind: "service", id: "fleet-ops" },
			tenant: TENANT,
		},
	);
}

/** The authority after a restore: the same store and bus, the next incarnation. */
function restored(h: Harness, incarnation: number): EnrollmentAuthority {
	return createEnrollmentAuthority({ ...h.deps, incarnation }, h.parts);
}

async function proofOnly(
	h: Harness,
	authority: EnrollmentAuthority,
	laptop: TestDevice,
) {
	const url = `${ISSUER}/v1/fleet/members/${laptop.keys.memberId}/credentials`;
	return value(
		await authority.authenticate({
			method: "POST",
			url,
			authorization: "",
			dpop: await dpopFor(laptop, "POST", url, h.clock.now()),
		}),
	);
}

async function svidRequest(h: Harness, laptop: TestDevice, svid: string) {
	const url = `${ISSUER}/v1/fleet/members`;
	return {
		method: "GET",
		url,
		authorization: `DPoP ${svid}`,
		dpop: await dpopFor(laptop, "GET", url, h.clock.now(), svid),
	};
}

/**
 * An issuer standing in for L09's: it verifies the tokens it was told about
 * (their claims are only read, after verification, by `authenticate`) and
 * answers `refusal` for every other token.
 */
function claimIssuer(
	h: Harness,
	refusal?: Outcome<VerifiedToken>,
): CredentialIssuer & {
	mint(
		claims: Readonly<{ iat: number; incarnation?: number }>,
		as: VerifiedToken,
	): string;
} {
	const known = new Map<string, VerifiedToken>();
	const part = (value: Readonly<Record<string, string | number>>) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return {
		...h.deps.issuer,
		verify(token, audience, nowMs) {
			const verified = known.get(token);
			// A fresh value per verification, as a real issuer decodes one.
			if (verified !== undefined) return { ok: true, value: { ...verified } };
			return refusal ?? h.deps.issuer.verify(token, audience, nowMs);
		},
		mint(claims, as) {
			const token = `${part({ alg: "RS256", typ: "JWT" })}.${part({ ...claims, iss: ISSUER })}.${part({ n: known.size })}`;
			known.set(token, as);
			return token;
		},
	};
}

async function setUp() {
	const h = await harness();
	await h.fleet("build");
	const admin = await h.person({ kind: "user", id: "admin" });
	const laptop = await active(h, admin.caller);
	const memberId = laptop.keys.memberId;
	const issued = value(
		await h.authority.credentials(
			{ memberId, request: refresh(0, new Uint8Array(randomBytes(16))) },
			await proofOnly(h, h.authority, laptop),
		),
	);
	return { h, admin, laptop, memberId, issued };
}

describe("incarnation-stale", () => {
	it("refuses an SVID and a person token minted before the restore, in authenticate", async () => {
		const { h, admin, laptop, issued } = await setUp();
		const before = value(
			await h.authority.authenticate(await svidRequest(h, laptop, issued.svid)),
		);
		expect(before.kind).toBe("member");

		h.clock.advance(5_000);
		await rotateTrust(h, 2, 2);
		const after = restored(h, 2);
		expect(
			code(await after.authenticate(await svidRequest(h, laptop, issued.svid))),
		).toBe("incarnation-stale");

		const personUrl = `${ISSUER}/v1/fleet/members`;
		const personProof = await mintDpopProof(
			admin.key.signer,
			admin.key.publicJwk,
			{
				htm: "GET",
				htu: personUrl,
				nowMs: h.clock.now(),
				accessToken: admin.token,
			},
		);
		expect(
			code(
				await after.authenticate({
					method: "GET",
					url: personUrl,
					authorization: `DPoP ${admin.token}`,
					dpop: personProof,
				}),
			),
		).toBe("incarnation-stale");
	});

	it("refuses, in credentials, a caller whose SVID was minted before the restore, and lets the device refresh by its SIGN key", async () => {
		const { h, laptop, memberId, issued } = await setUp();
		const svidCaller = value(
			await h.authority.authenticate(await svidRequest(h, laptop, issued.svid)),
		);
		h.clock.advance(5_000);
		await rotateTrust(h, 2, 2);
		const after = restored(h, 2);
		expect(
			code(
				await after.credentials(
					{ memberId, request: refresh(issued.generation) },
					svidCaller,
				),
			),
		).toBe("incarnation-stale");

		// The device refreshes by its SIGN-key proof and gets a current SVID.
		const renewed = value(
			await after.credentials(
				{ memberId, request: refresh(issued.generation) },
				await proofOnly(h, after, laptop),
			),
		);
		const current = value(
			await after.authenticate(await svidRequest(h, laptop, renewed.svid)),
		);
		expect(current.kind).toBe("member");
		value(
			await after.credentials(
				{ memberId, request: refresh(renewed.generation) },
				current,
			),
		);
	});

	it("passes the issuer's own incarnation-stale through, not as unauthenticated", async () => {
		const { h, laptop } = await setUp();
		const issuer = claimIssuer(h, {
			ok: false,
			error: {
				code: "incarnation-stale",
				message: "the token's incarnation is before the current one",
			},
		});
		const authority = createEnrollmentAuthority({ ...h.deps, issuer }, h.parts);
		expect(
			code(
				await authority.authenticate(
					await svidRequest(h, laptop, "aaa.bbb.ccc"),
				),
			),
		).toBe("incarnation-stale");
		// Any other failure to verify stays unauthenticated.
		const other = createEnrollmentAuthority(
			{
				...h.deps,
				issuer: claimIssuer(h, {
					ok: false,
					error: { code: "proof-invalid", message: "bad signature" },
				}),
			},
			h.parts,
		);
		expect(
			code(
				await other.authenticate(await svidRequest(h, laptop, "aaa.bbb.ccc")),
			),
		).toBe("unauthenticated");
	});

	it("prefers the token's incarnation claim to its iat when the token carries one", async () => {
		const { h, laptop, memberId, issued } = await setUp();
		const issuer = claimIssuer(h);
		const as = { ...laptop.caller, expiresAtMs: h.clock.now() + 3_600_000 };
		const seconds = (ms: number) => Math.floor(ms / 1_000);
		// Minted under incarnation 1, after the moment the restore will begin (by iat it would pass).
		h.clock.advance(5_000);
		const restoreAt = h.clock.now();
		const late = issuer.mint(
			{ iat: seconds(restoreAt) + 2, incarnation: 1 },
			as,
		);
		// Minted under incarnation 2, with an iat before the restore began (by iat it would be stale).
		const early = issuer.mint(
			{ iat: seconds(restoreAt) - 60, incarnation: 2 },
			as,
		);
		const before = createEnrollmentAuthority({ ...h.deps, issuer }, h.parts);
		const lateCaller = value(
			await before.authenticate(await svidRequest(h, laptop, late)),
		);

		await rotateTrust(h, 2, 2);
		const after = createEnrollmentAuthority(
			{ ...h.deps, issuer, incarnation: 2 },
			h.parts,
		);
		h.clock.advance(3_000);
		expect(
			code(await after.authenticate(await svidRequest(h, laptop, late))),
		).toBe("incarnation-stale");
		const current = value(
			await after.authenticate(await svidRequest(h, laptop, early)),
		);
		expect(current.kind).toBe("member");
		// credentials applies the same rule to the caller it is handed.
		expect(
			code(
				await after.credentials(
					{ memberId, request: refresh(issued.generation) },
					lateCaller,
				),
			),
		).toBe("incarnation-stale");
		value(
			await after.credentials(
				{ memberId, request: refresh(issued.generation) },
				current,
			),
		);
	});

	it("keeps the iat rule for a token without an incarnation claim", async () => {
		const { h, laptop } = await setUp();
		const issuer = claimIssuer(h);
		const as = { ...laptop.caller, expiresAtMs: h.clock.now() + 3_600_000 };
		const seconds = (ms: number) => Math.floor(ms / 1_000);
		const old = issuer.mint({ iat: seconds(h.clock.now()) }, as);
		h.clock.advance(5_000);
		await rotateTrust(h, 2, 2);
		const fresh = issuer.mint({ iat: seconds(h.clock.now()) + 1 }, as);
		const after = createEnrollmentAuthority(
			{ ...h.deps, issuer, incarnation: 2 },
			h.parts,
		);
		expect(
			code(await after.authenticate(await svidRequest(h, laptop, old))),
		).toBe("incarnation-stale");
		expect(
			value(await after.authenticate(await svidRequest(h, laptop, fresh))).kind,
		).toBe("member");
	});

	it("stales nothing for a trust rotation within one incarnation", async () => {
		const { h, laptop, issued } = await setUp();
		h.clock.advance(5_000);
		await rotateTrust(h, 1, 2);
		const same = restored(h, 1);
		expect(
			(await same.authenticate(await svidRequest(h, laptop, issued.svid))).ok,
		).toBe(true);
	});
});
