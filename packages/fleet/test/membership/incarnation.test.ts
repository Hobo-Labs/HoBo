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
import type { EnrollmentAuthority } from "../../src/ports.js";
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
