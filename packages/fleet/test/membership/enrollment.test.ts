import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ApprovalMode,
	AttestationTier,
	DeclareRequestSchema,
	DeviceClass,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	Role,
	type SignedEnvelope,
	TokenCreateRequestSchema,
} from "../../src/_generated/fleet_pb.js";
import { MEMBER_RECORD_CONTEXT } from "../../src/contexts.js";
import { parseFleetId, parseMemberName } from "../../src/ids.js";
import { sponsoredMemberId, verifyEnvelope } from "../../src/keys/index.js";
import type { Outcome, VerifiedToken } from "../../src/ports.js";
import {
	device,
	enrollment,
	type Harness,
	harness,
	minter,
	OWNER,
	TENANT,
	why,
} from "./fixtures.js";

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.value;
}

function decoded(envelope: SignedEnvelope | undefined): MemberRecord {
	if (envelope === undefined) throw new Error("no record");
	return fromBinary(MemberRecordSchema, envelope.payload);
}

async function invite(
	h: Harness,
	caller: VerifiedToken,
	fleet = "build",
	name = "laptop",
) {
	return value(
		await h.authority.issueToken(
			create(TokenCreateRequestSchema, {
				fleet,
				name,
				deviceClass: DeviceClass.PERSONAL,
				roles: [Role.EXECUTOR],
				ttlSeconds: 900,
			}),
			caller,
		),
	);
}

describe("enrollment with a bootstrap token", () => {
	it("records only the token's hash and enrolls PENDING under SINGLE approval", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = await h.person({ kind: "user", id: "admin" });
		const issued = await invite(h, admin.caller);
		expect(issued.token).toMatch(/^hft_[A-Za-z0-9_-]{43}$/u);

		const journal: string[] = [];
		for await (const positioned of h.store.readAll())
			journal.push(JSON.stringify(positioned.event.data));
		expect(journal.join("\n")).not.toContain(issued.token);

		const laptop = await device(h.clock.now());
		const response = value(
			await h.authority.enroll(
				enrollment(laptop, {
					fleet: "build",
					proof: { case: "bootstrapToken", value: issued.token },
				}),
				undefined,
			),
		);
		const record = decoded(response.memberRecord);
		expect(record.memberId).toBe(laptop.keys.memberId);
		expect(record.state).toBe(MemberState.PENDING);
		expect(record.memberships[0]?.roles).toEqual([Role.EXECUTOR]);
		expect(record.owner).toBe("user:admin");
		expect(record.ownerAliases).toEqual(["github:42"]);
		expect(record.attestationTier).toBe(AttestationTier.T0_SOFTWARE_KEY);
		expect(record.recordSequence).toBe(1);
		expect(
			// SAFETY: decoded() above threw unless the record is present.
			verifyEnvelope(
				response.memberRecord as SignedEnvelope,
				MEMBER_RECORD_CONTEXT,
				{
					kty: "OKP",
					crv: "Ed25519",
					x: h.recordKey,
				},
			),
		).toBe(true);
		expect(response.discovery?.issuer).toBe("https://authority.fleet.test");
		expect(response.discovery?.trust).toBeDefined();
		expect(response.overlayJoins).toEqual([]);
	});

	it("is idempotent for the same key and refuses the token for another", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = await h.person({ kind: "user", id: "admin" });
		const issued = await invite(h, admin.caller);
		const laptop = await device(h.clock.now());
		const request = enrollment(laptop, {
			proof: { case: "bootstrapToken", value: issued.token },
		});
		const first = value(await h.authority.enroll(request, undefined));
		const again = value(await h.authority.enroll(request, undefined));
		expect(decoded(again.memberRecord)).toEqual(decoded(first.memberRecord));

		const thief = await device(h.clock.now());
		const stolen = await h.authority.enroll(
			enrollment(thief, {
				proof: { case: "bootstrapToken", value: issued.token },
			}),
			undefined,
		);
		expect(stolen.ok ? "" : stolen.error.code).toBe("token-used");
	});

	it("approve-key then accept activates; AUTO_OWNER by the owner activates at once", async () => {
		const h = await harness();
		await h.fleet("build");
		await h.fleet("auto", { approval: ApprovalMode.AUTO_OWNER });
		const owner = await h.person(OWNER);
		const pendingToken = await invite(h, owner.caller, "build", "one");
		const autoToken = await invite(h, owner.caller, "auto", "two");

		const one = await device(h.clock.now());
		value(
			await h.authority.enroll(
				enrollment(one, {
					name: "one",
					proof: { case: "bootstrapToken", value: pendingToken.token },
				}),
				undefined,
			),
		);
		const approved = decoded(
			value(
				await h.authority.approveKey(
					{ memberId: one.keys.memberId, request: why() },
					owner.caller,
				),
			),
		);
		expect(approved.keyApprovedBy).toBe("user:owner");
		expect(approved.state).toBe(MemberState.PENDING);
		const accepted = decoded(
			value(
				await h.authority.accept(
					{ memberId: one.keys.memberId, request: why() },
					owner.caller,
				),
			),
		);
		expect(accepted.state).toBe(MemberState.ACTIVE);
		expect(accepted.acceptedBy).toBe("user:owner");

		const two = await device(h.clock.now());
		const auto = decoded(
			value(
				await h.authority.enroll(
					enrollment(two, {
						name: "two",
						proof: { case: "bootstrapToken", value: autoToken.token },
					}),
					undefined,
				),
			).memberRecord,
		);
		expect(auto.state).toBe(MemberState.ACTIVE);
	});

	it("DUAL needs approve-key and accept from two principals", async () => {
		const h = await harness();
		await h.fleet("dual", { approval: ApprovalMode.DUAL });
		const alice = await h.person({ kind: "user", id: "alice" });
		const bob = await h.person({ kind: "user", id: "bob" });
		const token = await invite(h, alice.caller, "dual");
		const laptop = await device(h.clock.now());
		value(
			await h.authority.enroll(
				enrollment(laptop, {
					fleet: "dual",
					proof: { case: "bootstrapToken", value: token.token },
				}),
				undefined,
			),
		);
		const id = laptop.keys.memberId;
		value(
			await h.authority.approveKey(
				{ memberId: id, request: why() },
				alice.caller,
			),
		);
		const same = await h.authority.accept(
			{ memberId: id, request: why() },
			alice.caller,
		);
		expect(same.ok ? "" : same.error.code).toBe("fleet-policy");
		expect(same.ok ? {} : same.error.detail).toEqual({ rule: "dual-control" });
		const second = decoded(
			value(
				await h.authority.accept({ memberId: id, request: why() }, bob.caller),
			),
		);
		expect(second.state).toBe(MemberState.ACTIVE);
	});
});

describe("enrollment with a person token", () => {
	it("enrolls when the person token is bound to the identity key", async () => {
		const h = await harness();
		await h.fleet("build", { approval: ApprovalMode.AUTO_OWNER });
		const laptop = await device(h.clock.now());
		const person = await h.person(OWNER, ["fleet-admin"], {
			signer: laptop.keys.identity,
			publicJwk: laptop.identity,
		});
		const response = value(
			await h.authority.enroll(
				enrollment(laptop, {
					fleet: "build",
					proof: { case: "personToken", value: person.token },
				}),
				person.caller,
			),
		);
		expect(decoded(response.memberRecord).state).toBe(MemberState.ACTIVE);
	});

	it("refuses a browser enrollment whose person token is bound to another key", async () => {
		const h = await harness();
		await h.fleet("build");
		const laptop = await device(h.clock.now());
		const person = await h.person(OWNER);
		const refused = await h.authority.enroll(
			enrollment(laptop, {
				fleet: "build",
				proof: { case: "personToken", value: person.token },
			}),
			person.caller,
		);
		expect(refused.ok ? "" : refused.error.code).toBe("proof-invalid");
	});

	it("refuses a person token the authority did not issue", async () => {
		const h = await harness();
		await h.fleet("build");
		const laptop = await device(h.clock.now());
		const other = await harness();
		const forged = await other.person(OWNER, ["fleet-admin"], {
			signer: laptop.keys.identity,
			publicJwk: laptop.identity,
		});
		const refused = await h.authority.enroll(
			enrollment(laptop, {
				fleet: "build",
				proof: { case: "personToken", value: forged.token },
			}),
			undefined,
		);
		expect(refused.ok ? "" : refused.error.code).toBe("unauthenticated");
	});
});

describe("enrollment with a workload identity", () => {
	it("accepts a matching oidc_trust rule as EPHEMERAL at T3, once", async () => {
		const audiences: string[] = [];
		const h = await harness({
			assertions: {
				async verifyOidc(_assertion, audience) {
					audiences.push(audience);
					return {
						ok: true,
						value: {
							issuer: "https://token.actions.githubusercontent.com",
							subject: "repo:acme/app:ref:refs/heads/main",
							tokenId: "jti-1",
							claims: { repository: "acme/app" },
						},
					};
				},
				verifyCertificateChain: () => ({
					ok: false,
					error: { code: "unauthenticated", message: "no" },
				}),
			},
		});
		await h.fleet("ci", {
			oidcTrust: [
				{
					issuer: "https://token.actions.githubusercontent.com",
					subjectPattern: "repo:acme/.*",
					requiredClaims: { repository: "acme/app" },
					roles: [Role.EXECUTOR],
					sponsor: false,
				},
			].map((rule) => ({
				...rule,
				$typeName: "hobo.fleet.v1.OidcTrustRule" as const,
			})),
		});
		const runner = await device(h.clock.now());
		const response = value(
			await h.authority.enroll(
				enrollment(runner, {
					fleet: "ci",
					name: "runner",
					proof: { case: "oidcAssertion", value: "jwt" },
				}),
				undefined,
			),
		);
		const record = decoded(response.memberRecord);
		expect(audiences).toEqual([
			`https://authority.fleet.test#${runner.thumbprint}`,
		]);
		expect(record.state).toBe(MemberState.ACTIVE);
		expect(record.deviceClass).toBe(DeviceClass.EPHEMERAL);
		expect(record.attestationTier).toBe(AttestationTier.T3_PLATFORM_IDENTITY);

		const replayed = await h.authority.enroll(
			enrollment(await device(h.clock.now()), {
				fleet: "ci",
				name: "runner2",
				proof: { case: "oidcAssertion", value: "jwt" },
			}),
			undefined,
		);
		expect(replayed.ok ? "" : replayed.error.code).toBe("proof-replayed");
	});
});

describe("declaring sponsored members", () => {
	it("gives two backends of one name in two fleets different ids", async () => {
		const h = await harness();
		await h.fleet("cache-a", { approval: ApprovalMode.AUTO_OWNER });
		await h.fleet("cache-b", { approval: ApprovalMode.AUTO_OWNER });
		const owner = await h.person(OWNER);
		const declare = (fleet: string) =>
			h.authority.declare(
				create(DeclareRequestSchema, {
					fleet,
					kind: MemberKind.BACKEND,
					name: "redis",
					credentialRef: "secret://cache/redis",
					endpointDigest: `sha256:${"a".repeat(64)}`,
				}),
				owner.caller,
			);
		const a = decoded(value(await declare("cache-a")).memberRecord);
		const b = decoded(value(await declare("cache-b")).memberRecord);
		expect(a.memberId).not.toBe(b.memberId);
		expect(a.memberId).toBe(
			sponsoredMemberId(
				TENANT,
				MemberKind.BACKEND,
				parseFleetId("cache-a"),
				parseMemberName("redis"),
			),
		);
		expect(a.state).toBe(MemberState.ACTIVE);
		expect(a.sponsor).toBe("user:owner");
		expect(a.credentialRef).toBe("secret://cache/redis");
		expect((await declare("cache-a")).ok).toBe(true);
	});

	it("refuses a second member of one name in one fleet with name-taken", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = await h.person({ kind: "user", id: "admin" });
		value(
			await h.authority.declare(
				create(DeclareRequestSchema, {
					fleet: "build",
					kind: MemberKind.TARGET,
					name: "laptop",
				}),
				admin.caller,
			),
		);
		const token = await h.authority.issueToken(
			create(TokenCreateRequestSchema, {
				fleet: "build",
				name: "laptop",
				ttlSeconds: 900,
			}),
			admin.caller,
		);
		expect(token.ok ? "" : token.error.code).toBe("name-taken");
		const sponsor = await h.person({ kind: "user", id: "someone-else" });
		const backend = await h.authority.declare(
			create(DeclareRequestSchema, {
				fleet: "build",
				kind: MemberKind.BACKEND,
				name: "laptop",
			}),
			sponsor.caller,
		);
		expect(backend.ok ? "" : backend.error.code).toBe("name-taken");
	});
});

describe("overlay joins at enrollment", () => {
	it("carries one join per minter for an ACTIVE device, and leaves out a failing one", async () => {
		const seen: string[] = [];
		const h = await harness({
			minters: [
				minter("tailscale", "ok", seen),
				minter("netbird", "fail", seen),
			],
		});
		await h.fleet("build", { approval: ApprovalMode.AUTO_OWNER });
		const owner = await h.person(OWNER);
		const token = await invite(h, owner.caller);
		const laptop = await device(h.clock.now());
		const response = value(
			await h.authority.enroll(
				enrollment(laptop, {
					proof: { case: "bootstrapToken", value: token.token },
				}),
				undefined,
			),
		);
		expect(response.overlayJoins.map((join) => join.provider)).toEqual([
			"tailscale",
		]);
		expect(seen).toEqual([
			`tailscale:${laptop.keys.memberId}:600000:fleet-build`,
			`netbird:${laptop.keys.memberId}:600000:fleet-build`,
		]);
		expect(h.logged.join(" ")).not.toContain("single-use");
	});

	it("carries one join per minter, including one that throws being left out", async () => {
		const h = await harness({
			minters: [minter("tailscale", "throw"), minter("netbird", "ok")],
		});
		await h.fleet("build", { approval: ApprovalMode.AUTO_OWNER });
		const owner = await h.person(OWNER);
		const token = await invite(h, owner.caller);
		const response = value(
			await h.authority.enroll(
				enrollment(await device(h.clock.now()), {
					proof: { case: "bootstrapToken", value: token.token },
				}),
				undefined,
			),
		);
		expect(response.overlayJoins.map((join) => join.provider)).toEqual([
			"netbird",
		]);
	});

	it("gives a PENDING device and a declared backend no joins", async () => {
		const h = await harness({ minters: [minter("tailscale", "ok")] });
		await h.fleet("build");
		const admin = await h.person({ kind: "user", id: "admin" });
		const token = await invite(h, admin.caller);
		const pending = value(
			await h.authority.enroll(
				enrollment(await device(h.clock.now()), {
					proof: { case: "bootstrapToken", value: token.token },
				}),
				undefined,
			),
		);
		expect(pending.overlayJoins).toEqual([]);
	});
});
