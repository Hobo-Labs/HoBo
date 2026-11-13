// O40: the fleet commands refuse what they must. One case per refusal of
// defineFleet, grantSession, submitWork and fleetVerdict (§6.12, §6.13,
// §7.2, §7.6), ONE_ACTIVE refused in authority mode and accepted in local
// mode (D39), a workload token for an unlisted repository refused on the
// verdict route, and a submission published once under retry.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CoordinationMode,
	DeviceClass,
	FleetRecordSchema,
	FleetViewSchema,
	KeyPurpose,
	MemberKind,
	MemberState,
	PublicKeyRefSchema,
	ReceiptStatus,
	RepositoryRuleSchema,
	SandboxTier,
	type SessionGrant,
	SessionGrantSchema,
	SessionPartySchema,
	SessionPurpose,
	type SessionRequest,
	SessionRequestSchema,
	type SignedEnvelope,
	VerdictState,
	WorkNeedsSchema,
	WorkSubmissionRequestSchema,
	WorkSubmissionSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	SESSION_GRANT_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
} from "../../src/contexts.js";
import { parseFleetId } from "../../src/ids.js";
import { verifyEnvelope } from "../../src/keys/index.js";
import { buildFleetView } from "../../src/observation/view.js";
import type { FleetEventStore } from "../../src/ports.js";
import {
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";
import {
	dev,
	errorOf,
	fleetRecord,
	type Harness,
	harness,
	type InitOf,
	OTHER_TENANT,
	oneActiveRecord,
	unwrap,
} from "./fixtures.js";

/** A number no SandboxTier has. */
const NOT_A_TIER: number = 9;

async function events(
	store: FleetEventStore,
	prefix: string,
): Promise<EventEnvelope[]> {
	const out: EventEnvelope[] = [];
	for await (const positioned of store.readAll())
		if (positioned.event.streamId.startsWith(prefix))
			out.push(positioned.event);
	return out;
}

function verifiesAs(
	h: Harness,
	envelope: SignedEnvelope,
	context: Parameters<typeof verifyEnvelope>[1],
): boolean {
	return verifyEnvelope(
		envelope,
		context,
		create(PublicKeyRefSchema, {
			purpose: KeyPurpose.AUTHORITY,
			keyId: h.authorityKey.signer.keyId,
			algorithm: h.authorityKey.signer.algorithm,
			value: h.authorityKey.raw,
		}),
	);
}

// ── defineFleet ────────────────────────────────────────────────────────────
describe("defineFleet", () => {
	it("defines a fleet, journals fleet.FleetDefined with its revision, and publishes the record before anyone enrolls", async () => {
		const h = harness();
		const signed = unwrap(
			await h.commands.defineFleet(fleetRecord("build"), h.admin),
		);
		expect(verifiesAs(h, signed, FLEET_RECORD_CONTEXT)).toBe(true);
		const record = fromBinary(FleetRecordSchema, signed.payload);
		expect(record).toMatchObject({
			fleetId: "build",
			tenant: "acme",
			owner: "user:admin",
			revision: 1,
			updatedBy: "user:admin",
			coordination: CoordinationMode.MANY_ACTIVE,
		});
		expect(record.notAfter > record.issuedAt).toBe(true);
		// Published at once: the enrollment commands read fleets from the registry.
		const published = await h.bus.registry.fleet(parseFleetId("build"));
		expect(published?.revision).toBe(1);
		const journal = await events(h.store, "fleet-fleet-");
		expect(journal.map((event) => event.type)).toEqual(["fleet.FleetDefined"]);
		expect(journal[0]?.streamId).toBe("fleet-fleet-build");
		expect(journal[0]?.data).toMatchObject({
			subject: "fleet.build",
			subjectSequence: 1,
			revision: 1,
		});
		expect(h.logged.map((entry) => entry.event)).toContain(
			"hobo_fleet_fleet_defined",
		);
	});

	it("changes policy as fleet.FleetPolicyChanged with the next revision, and an identical PUT changes nothing", async () => {
		const h = harness();
		await h.fleet("build");
		const changed = unwrap(
			await h.commands.defineFleet(
				fleetRecord("build", { labels: ["linux-x64"] }),
				h.admin,
			),
		);
		const record = fromBinary(FleetRecordSchema, changed.payload);
		expect(record.revision).toBe(2);
		expect(record.policy?.labels).toEqual(["linux-x64"]);
		const again = unwrap(
			await h.commands.defineFleet(
				fleetRecord("build", { labels: ["linux-x64"] }),
				h.admin,
			),
		);
		expect(fromBinary(FleetRecordSchema, again.payload).revision).toBe(2);
		const journal = await events(h.store, "fleet-fleet-");
		expect(journal.map((event) => event.type)).toEqual([
			"fleet.FleetDefined",
			"fleet.FleetPolicyChanged",
		]);
		expect(journal[1]?.data).toMatchObject({
			subject: "fleet.build",
			subjectSequence: 2,
			revision: 2,
		});
		expect((await h.bus.registry.fleet(parseFleetId("build")))?.revision).toBe(
			2,
		);
	});

	it("keeps the owner of an existing fleet when someone else changes its policy", async () => {
		const h = harness();
		await h.fleet("build");
		const other = h.person(["fleet.policy.change"], "second");
		const changed = unwrap(
			await h.commands.defineFleet(
				fleetRecord("build", { labels: ["x"] }),
				other,
			),
		);
		const record = fromBinary(FleetRecordSchema, changed.payload);
		expect(record.owner).toBe("user:admin");
		expect(record.updatedBy).toBe("user:second");
	});

	it("governs a new fleet as fleet.define and a change as fleet.policy.change", async () => {
		const h = harness();
		const definer = h.person(["fleet.define"], "definer");
		expect(
			errorOf(await h.commands.defineFleet(fleetRecord("a"), definer)),
		).toBe("ok");
		expect(
			errorOf(
				await h.commands.defineFleet(
					fleetRecord("a", { labels: ["x"] }),
					definer,
				),
			),
		).toBe("forbidden");
		const changer = h.person(["fleet.policy.change"], "changer");
		expect(
			errorOf(await h.commands.defineFleet(fleetRecord("b"), changer)),
		).toBe("forbidden");
	});

	it("accepts ONE_ACTIVE in local mode", async () => {
		const h = harness({ mode: "local" });
		const signed = unwrap(
			await h.commands.defineFleet(oneActiveRecord("cache"), h.admin),
		);
		expect(fromBinary(FleetRecordSchema, signed.payload).coordination).toBe(
			CoordinationMode.ONE_ACTIVE,
		);
	});

	it("two instances on one store never lose a change", async () => {
		const store = createMemoryEventStore();
		const h = harness({ store });
		await h.fleet("build");
		const other = h.another();
		const results = await Promise.all([
			h.commands.defineFleet(fleetRecord("build", { labels: ["a"] }), h.admin),
			other.defineFleet(fleetRecord("build", { labels: ["b"] }), h.admin),
		]);
		const revisions = results
			.map((result) => fromBinary(FleetRecordSchema, unwrap(result).payload))
			.map((record) => record.revision)
			.sort();
		expect(revisions).toEqual([2, 3]);
		const listed = unwrap(await other.listFleets({}, h.admin));
		expect(
			fromBinary(
				FleetRecordSchema,
				listed.fleets[0]?.payload ?? new Uint8Array(),
			).revision,
		).toBe(3);
	});

	describe("refusals", () => {
		const h = harness();
		const cases: readonly Readonly<{
			name: string;
			run: () => Promise<string>;
			code: string;
			rule?: string;
		}>[] = [
			{
				name: "no caller",
				code: "unauthenticated",
				run: async () =>
					errorOf(await h.commands.defineFleet(fleetRecord("x"), undefined)),
			},
			{
				name: "a device caller",
				code: "unauthenticated",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(fleetRecord("x"), h.device(dev(1))),
					),
			},
			{
				name: "a person of another tenant",
				code: "forbidden",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(fleetRecord("x"), {
							...h.person(["fleet-admin"]),
							tenant: OTHER_TENANT,
						}),
					),
			},
			{
				name: "policy denies fleet.define",
				code: "forbidden",
				run: async () =>
					errorOf(await h.commands.defineFleet(fleetRecord("x"), h.person([]))),
			},
			{
				name: "a malformed fleet id",
				code: "invalid-request",
				run: async () =>
					errorOf(await h.commands.defineFleet(fleetRecord("Bad Id"), h.admin)),
			},
			{
				name: "a record for another tenant",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							create(FleetRecordSchema, {
								...fleetRecord("x"),
								tenant: "other",
							}),
							h.admin,
						),
					),
			},
			{
				name: "no coordination mode",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", {}, CoordinationMode.UNSPECIFIED),
							h.admin,
						),
					),
			},
			{
				name: "no approval mode",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { approval: 0 }),
							h.admin,
						),
					),
			},
			{
				name: "no policy at all",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							create(FleetRecordSchema, {
								fleetId: "x",
								coordination: CoordinationMode.MANY_ACTIVE,
							}),
							h.admin,
						),
					),
			},
			{
				name: "ONE_ACTIVE in authority mode",
				code: "fleet-policy",
				rule: "one-active-authority",
				run: async () => {
					const result = await h.commands.defineFleet(
						oneActiveRecord("cache"),
						h.admin,
					);
					return result.ok
						? "ok"
						: `${result.error.code}/${result.error.detail?.rule}`;
				},
			},
			{
				name: "allow_host_docker without DEDICATED-only classes",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", {
								allowHostDocker: true,
								allowedClasses: [DeviceClass.DEDICATED, DeviceClass.PERSONAL],
							}),
							h.admin,
						),
					),
			},
			{
				name: "org_min_sandbox below S3 without repositories",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { orgMinSandbox: SandboxTier.S1_CONTAINER }),
							h.admin,
						),
					),
			},
			{
				name: "a wildcard egress host",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { egressAllow: ["*.example.com"] }),
							h.admin,
						),
					),
			},
			{
				name: "an upper-case egress host",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { egressAllow: ["Example.com"] }),
							h.admin,
						),
					),
			},
			{
				name: "key_bundle_hours above 720",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { keyBundleHours: 721 }),
							h.admin,
						),
					),
			},
			{
				name: "membership_epochs on a many-active fleet",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { membershipEpochs: true }),
							h.admin,
						),
					),
			},
			{
				name: "recovery_point_ms on a many-active fleet",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", { recoveryPointMs: 1_000 }),
							h.admin,
						),
					),
			},
			{
				name: "a repository rule that is not owner/name",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", {
								repositories: [
									create(RepositoryRuleSchema, {
										repository: "not-a-repo",
										refs: ["refs/heads/main"],
									}),
								],
							}),
							h.admin,
						),
					),
			},
			{
				name: "an OIDC subject pattern that does not compile",
				code: "invalid-request",
				run: async () =>
					errorOf(
						await h.commands.defineFleet(
							fleetRecord("x", {
								oidcTrust: [
									{
										issuer: "https://issuer.example",
										subjectPattern: "(",
										requiredClaims: {},
										roles: [],
										sponsor: false,
										$typeName: "hobo.fleet.v1.OidcTrustRule",
									},
								],
							}),
							h.admin,
						),
					),
			},
		];
		for (const entry of cases)
			it(`refuses ${entry.name} with ${entry.code}`, async () => {
				expect(await entry.run()).toBe(
					entry.rule === undefined ? entry.code : `${entry.code}/${entry.rule}`,
				);
			});

		it("refuses a one-active fleet without a BACKEND kind or failover_after_ms (local mode)", async () => {
			const local = harness({ mode: "local" });
			const noBackend = oneActiveRecord("c1");
			if (noBackend.policy !== undefined)
				noBackend.policy.allowedKinds = [MemberKind.DEVICE];
			expect(
				errorOf(await local.commands.defineFleet(noBackend, local.admin)),
			).toBe("invalid-request");
			const noFailover = oneActiveRecord("c2");
			if (noFailover.policy !== undefined)
				noFailover.policy.failoverAfterMs = 0;
			expect(
				errorOf(await local.commands.defineFleet(noFailover, local.admin)),
			).toBe("invalid-request");
		});

		it("refuses to change an existing fleet's coordination mode", async () => {
			const local = harness({ mode: "local" });
			await local.fleet("pool");
			const result = await local.commands.defineFleet(
				oneActiveRecord("pool"),
				local.admin,
			);
			expect(
				result.ok ? "ok" : `${result.error.code}/${result.error.detail?.rule}`,
			).toBe("fleet-policy/coordination-immutable");
		});

		it("journals nothing for a refused definition", async () => {
			expect(await events(h.store, "fleet-fleet-")).toEqual([]);
		});
	});
});

// ── Reads ──────────────────────────────────────────────────────────────────
describe("listFleets and getFleet", () => {
	it("serve signed records to readers, from the journal", async () => {
		const h = harness();
		await h.fleet("b");
		await h.fleet("a");
		for (const reader of [h.admin, h.device(dev(1)), h.account([])]) {
			const list = unwrap(await h.commands.listFleets({}, reader));
			expect(
				list.fleets.map(
					(envelope) => fromBinary(FleetRecordSchema, envelope.payload).fleetId,
				),
			).toEqual(["a", "b"]);
			const one = unwrap(await h.commands.getFleet({ fleetId: "a" }, reader));
			expect(verifiesAs(h, one, FLEET_RECORD_CONTEXT)).toBe(true);
		}
	});

	it("refuse unauthenticated callers, other tenants and unknown fleets", async () => {
		const h = harness();
		await h.fleet("a");
		expect(errorOf(await h.commands.listFleets({}, undefined))).toBe(
			"unauthenticated",
		);
		expect(
			errorOf(await h.commands.listFleets({}, h.workload("acme/app"))),
		).toBe("unauthenticated");
		expect(
			errorOf(
				await h.commands.getFleet(
					{ fleetId: "a" },
					h.device(dev(1), OTHER_TENANT),
				),
			),
		).toBe("forbidden");
		expect(
			errorOf(await h.commands.getFleet({ fleetId: "zzz" }, h.admin)),
		).toBe("fleet-unknown");
		expect(
			errorOf(await h.commands.getFleet({ fleetId: "Not A Fleet" }, h.admin)),
		).toBe("fleet-unknown");
	});
});

// ── fleetView and fleetVerdict ─────────────────────────────────────────────
describe("fleetView", () => {
	it("serves the registry's view, signed by the authority", async () => {
		const h = harness();
		const fleet = await h.fleet("build");
		const view = buildFleetView(fleet, [], [], new Map(), h.clock.now());
		view.truncated = true;
		await h.bus.publisher.putView(
			{
				context: FLEET_VIEW_CONTEXT,
				keyId: h.authorityKey.signer.keyId,
				algorithm: h.authorityKey.signer.algorithm,
				payload: toBinary(FleetViewSchema, view),
				signature: await h.authorityKey.signer.sign(new Uint8Array()),
				$typeName: "hobo.fleet.v1.SignedEnvelope",
			},
			parseFleetId("build"),
		);
		const signed = unwrap(
			await h.commands.fleetView({ fleetId: "build" }, h.admin),
		);
		expect(verifiesAs(h, signed, FLEET_VIEW_CONTEXT)).toBe(true);
		expect(fromBinary(FleetViewSchema, signed.payload).truncated).toBe(true);
	});

	it("builds a view from the registry's members when none has been published yet", async () => {
		const h = harness();
		await h.fleet("build");
		await h.member({
			memberId: dev(1),
			fleets: [{ fleet: "build", name: "box" }],
		});
		const signed = unwrap(
			await h.commands.fleetView({ fleetId: "build" }, h.device(dev(1))),
		);
		const view = fromBinary(FleetViewSchema, signed.payload);
		expect(view.fleet).toBe("build");
		expect(view.members.map((member) => member.name)).toEqual(["box"]);
	});

	it("refuses unauthenticated callers and unknown fleets", async () => {
		const h = harness();
		expect(
			errorOf(await h.commands.fleetView({ fleetId: "build" }, undefined)),
		).toBe("unauthenticated");
		expect(
			errorOf(await h.commands.fleetView({ fleetId: "build" }, h.admin)),
		).toBe("fleet-unknown");
	});
});

describe("fleetVerdict", () => {
	async function setup() {
		const h = harness();
		await h.fleet("build", {
			repositories: [
				create(RepositoryRuleSchema, {
					repository: "acme/app",
					refs: ["refs/heads/*"],
				}),
			],
		});
		return h;
	}

	it("answers readers and a workload of a listed repository from the view", async () => {
		const h = await setup();
		for (const caller of [h.admin, h.account([]), h.workload("acme/app")]) {
			const verdict = unwrap(
				await h.commands.fleetVerdict(
					{ fleetId: "build", label: "linux-x64" },
					caller,
				),
			);
			expect(verdict).toMatchObject({
				fleet: "build",
				label: "linux-x64",
				state: VerdictState.NO_MEMBER,
				members: 0,
			});
		}
	});

	const refusals: readonly Readonly<{
		name: string;
		code: string;
		run: (h: Harness) => Promise<string>;
	}>[] = [
		{
			name: "no caller",
			code: "unauthenticated",
			run: async (h) =>
				errorOf(
					await h.commands.fleetVerdict(
						{ fleetId: "build", label: "x" },
						undefined,
					),
				),
		},
		{
			name: "a workload token for an unlisted repository",
			code: "forbidden",
			run: async (h) =>
				errorOf(
					await h.commands.fleetVerdict(
						{ fleetId: "build", label: "x" },
						h.workload("acme/other"),
					),
				),
		},
		{
			name: "a workload token of another tenant",
			code: "forbidden",
			run: async (h) =>
				errorOf(
					await h.commands.fleetVerdict(
						{ fleetId: "build", label: "x" },
						h.workload("acme/app", OTHER_TENANT),
					),
				),
		},
		{
			name: "a person of another tenant",
			code: "forbidden",
			run: async (h) =>
				errorOf(
					await h.commands.fleetVerdict(
						{ fleetId: "build", label: "x" },
						{ ...h.admin, tenant: OTHER_TENANT },
					),
				),
		},
		{
			name: "an unknown fleet",
			code: "fleet-unknown",
			run: async (h) =>
				errorOf(
					await h.commands.fleetVerdict(
						{ fleetId: "nope", label: "x" },
						h.admin,
					),
				),
		},
		{
			name: "a label longer than 80 characters",
			code: "invalid-request",
			run: async (h) =>
				errorOf(
					await h.commands.fleetVerdict(
						{ fleetId: "build", label: "x".repeat(81) },
						h.admin,
					),
				),
		},
	];
	for (const entry of refusals)
		it(`refuses ${entry.name} with ${entry.code}`, async () => {
			expect(await entry.run(await setup())).toBe(entry.code);
		});
});

// ── grantSession ───────────────────────────────────────────────────────────
describe("grantSession", () => {
	const PEER = dev(1);
	const SELF = dev(2);
	const STRANGER = dev(3);

	async function setup() {
		const h = harness();
		await h.fleet("dev", {
			sessionPurposes: [SessionPurpose.SHELL, SessionPurpose.FORWARD],
		});
		await h.fleet("lonely", { sessionPurposes: [SessionPurpose.BLOB] });
		await h.member({
			memberId: PEER,
			fleets: [{ fleet: "dev", name: "peer" }],
		});
		await h.member({
			memberId: SELF,
			fleets: [{ fleet: "dev", name: "self" }],
		});
		await h.member({
			memberId: STRANGER,
			fleets: [{ fleet: "lonely", name: "stranger" }],
		});
		return h;
	}

	function request(
		overrides: InitOf<typeof SessionRequestSchema> = {},
	): SessionRequest {
		return create(SessionRequestSchema, {
			peer: PEER,
			purpose: SessionPurpose.SHELL,
			initiator: create(SessionPartySchema, {
				transportIdentity: "cli-endpoint",
				sealPublicKey: "cli-seal",
			}),
			ttlSeconds: 600,
			...overrides,
		});
	}

	function grantOf(envelope: SignedEnvelope): SessionGrant {
		return fromBinary(SessionGrantSchema, envelope.payload);
	}

	it("grants a person a shell, naming both parties from the registry, and journals fleet.SessionGranted", async () => {
		const h = await setup();
		const signed = unwrap(await h.commands.grantSession(request(), h.admin));
		expect(verifiesAs(h, signed, SESSION_GRANT_CONTEXT)).toBe(true);
		const grant = grantOf(signed);
		expect(grant.sessionId).toMatch(/^[0-9a-f]{32}$/u);
		expect(grant).toMatchObject({
			tenant: "acme",
			purpose: SessionPurpose.SHELL,
			initiator: {
				memberId: "",
				principal: "user:admin",
				transportIdentity: "cli-endpoint",
				sealPublicKey: "cli-seal",
			},
			acceptor: {
				memberId: PEER,
				transportIdentity: `endpoint-${PEER}`,
				sealPublicKey: `seal-${PEER}`,
			},
		});
		expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(
			600_000,
		);
		const journal = await events(h.store, "fleet-session-");
		expect(journal.map((event) => [event.type, event.streamId])).toEqual([
			["fleet.SessionGranted", `fleet-session-${grant.sessionId}`],
		]);
		expect(h.logged.map((entry) => entry.event)).toContain(
			"hobo_fleet_session_granted",
		);
	});

	it("grants a device a forward to a member of a fleet they share, with its own registered keys", async () => {
		const h = await setup();
		const grant = grantOf(
			unwrap(
				await h.commands.grantSession(
					request({
						purpose: SessionPurpose.FORWARD,
						port: 8080,
						initiator: create(SessionPartySchema, {
							memberId: SELF,
							transportIdentity: `endpoint-${SELF}`,
							sealPublicKey: `seal-${SELF}`,
						}),
					}),
					h.device(SELF),
				),
			),
		);
		expect(grant.initiator?.memberId).toBe(SELF);
		expect(grant.port).toBe(8080);
	});

	it("caps a missing ttl at the default and never exceeds an hour", async () => {
		const h = await setup();
		const grant = grantOf(
			unwrap(
				await h.commands.grantSession(request({ ttlSeconds: 0 }), h.admin),
			),
		);
		const ttl = Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt);
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(3_600_000);
	});

	const refusals: readonly Readonly<{
		name: string;
		code: string;
		rule?: string;
		run: (h: Harness) => ReturnType<Harness["commands"]["grantSession"]>;
	}>[] = [
		{
			name: "no caller",
			code: "unauthenticated",
			run: (h) => h.commands.grantSession(request(), undefined),
		},
		{
			name: "an account credential",
			code: "unauthenticated",
			run: (h) => h.commands.grantSession(request(), h.account()),
		},
		{
			name: "a workload token",
			code: "unauthenticated",
			run: (h) => h.commands.grantSession(request(), h.workload("acme/app")),
		},
		{
			name: "a person of another tenant",
			code: "forbidden",
			run: (h) =>
				h.commands.grantSession(request(), {
					...h.admin,
					tenant: OTHER_TENANT,
				}),
		},
		{
			name: "policy denies fleet.session.grant",
			code: "forbidden",
			run: (h) => h.commands.grantSession(request(), h.person([])),
		},
		{
			name: "a malformed peer",
			code: "invalid-request",
			run: (h) => h.commands.grantSession(request({ peer: "nobody" }), h.admin),
		},
		{
			name: "an unknown peer",
			code: "member-unknown",
			run: (h) => h.commands.grantSession(request({ peer: dev(99) }), h.admin),
		},
		{
			name: "a suspended peer",
			code: "member-suspended",
			run: async (h) => {
				await h.member({
					memberId: dev(7),
					state: MemberState.SUSPENDED,
					fleets: [{ fleet: "dev", name: "zz" }],
				});
				return h.commands.grantSession(request({ peer: dev(7) }), h.admin);
			},
		},
		{
			name: "a peer that is not a device",
			code: "invalid-request",
			run: async (h) => {
				const backend = `bkd_${"a".repeat(32)}`;
				await h.member({
					memberId: backend,
					kind: MemberKind.BACKEND,
					fleets: [{ fleet: "dev", name: "store" }],
				});
				return h.commands.grantSession(request({ peer: backend }), h.admin);
			},
		},
		{
			name: "no purpose",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({ purpose: SessionPurpose.UNSPECIFIED }),
					h.admin,
				),
		},
		{
			name: "a forward without a port",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({ purpose: SessionPurpose.FORWARD, port: 0 }),
					h.admin,
				),
		},
		{
			name: "a forward to a port above 65535",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({ purpose: SessionPurpose.FORWARD, port: 70_000 }),
					h.admin,
				),
		},
		{
			name: "a blob session naming no digests",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({ purpose: SessionPurpose.BLOB }),
					h.admin,
				),
		},
		{
			name: "a ttl above an hour",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(request({ ttlSeconds: 3_601 }), h.admin),
		},
		{
			name: "an initiator without a seal key",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({
						initiator: create(SessionPartySchema, {
							transportIdentity: "cli-endpoint",
						}),
					}),
					h.admin,
				),
		},
		{
			name: "a purpose no fleet of the peer allows",
			code: "fleet-policy",
			rule: "session-purpose",
			run: (h) =>
				h.commands.grantSession(
					request({
						purpose: SessionPurpose.BLOB,
						blobDigests: [`sha256:${"0".repeat(64)}`],
					}),
					h.admin,
				),
		},
		{
			name: "a device that shares no fleet with the peer",
			code: "fleet-policy",
			rule: "session-purpose",
			run: (h) =>
				h.commands.grantSession(
					request({
						initiator: create(SessionPartySchema, {
							memberId: STRANGER,
							transportIdentity: `endpoint-${STRANGER}`,
							sealPublicKey: `seal-${STRANGER}`,
						}),
					}),
					h.device(STRANGER),
				),
		},
		{
			name: "a device presenting keys that are not its own",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({
						initiator: create(SessionPartySchema, {
							memberId: SELF,
							transportIdentity: "someone-else",
							sealPublicKey: `seal-${SELF}`,
						}),
					}),
					h.device(SELF),
				),
		},
		{
			name: "a device naming another member as the initiator",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({
						initiator: create(SessionPartySchema, {
							memberId: PEER,
							transportIdentity: `endpoint-${PEER}`,
							sealPublicKey: `seal-${PEER}`,
						}),
					}),
					h.device(SELF),
				),
		},
		{
			name: "a device that is no longer in the registry",
			code: "member-unknown",
			run: (h) =>
				h.commands.grantSession(
					request({
						initiator: create(SessionPartySchema, {
							memberId: dev(55),
							transportIdentity: "x",
							sealPublicKey: "y",
						}),
					}),
					h.device(dev(55)),
				),
		},
		{
			name: "a revoked initiating device",
			code: "member-revoked",
			run: async (h) => {
				await h.member({
					memberId: dev(8),
					state: MemberState.REVOKED,
					fleets: [{ fleet: "dev", name: "gone" }],
				});
				return h.commands.grantSession(
					request({
						initiator: create(SessionPartySchema, {
							memberId: dev(8),
							transportIdentity: `endpoint-${dev(8)}`,
							sealPublicKey: `seal-${dev(8)}`,
						}),
					}),
					h.device(dev(8)),
				);
			},
		},
		{
			name: "a session with itself",
			code: "invalid-request",
			run: (h) =>
				h.commands.grantSession(
					request({
						peer: SELF,
						initiator: create(SessionPartySchema, {
							memberId: SELF,
							transportIdentity: `endpoint-${SELF}`,
							sealPublicKey: `seal-${SELF}`,
						}),
					}),
					h.device(SELF),
				),
		},
	];
	for (const entry of refusals)
		it(`refuses ${entry.name} with ${entry.code}`, async () => {
			const h = await setup();
			const result = await entry.run(h);
			expect(result.ok ? "ok" : result.error.code).toBe(entry.code);
			if (entry.rule !== undefined && !result.ok)
				expect(result.error.detail?.rule).toBe(entry.rule);
			expect(await events(h.store, "fleet-session-")).toEqual([]);
		});
});

// ── submitWork ─────────────────────────────────────────────────────────────
describe("submitWork", () => {
	const DIGEST = `sha256:${"ab".repeat(32)}`;

	async function setup(
		options: Parameters<typeof harness>[0] = {},
	): Promise<Harness> {
		const h = harness(options);
		await h.fleet("ci", {
			workKinds: ["oci-command"],
			egressAllow: ["registry.example.com"],
		});
		await h.fleet("gha", { workKinds: ["github-actions-job"] });
		return h;
	}

	function submission(
		overrides: InitOf<typeof WorkSubmissionRequestSchema> = {},
	) {
		return create(WorkSubmissionRequestSchema, {
			fleet: "ci",
			image: "registry.example.com/tools/lint",
			imageDigest: DIGEST,
			argv: ["lint", "--all"],
			env: { MODE: "strict" },
			egressAllow: ["registry.example.com"],
			ttlSeconds: 900,
			...overrides,
		});
	}

	function published(h: Harness): SignedEnvelope[] {
		const seen: SignedEnvelope[] = [];
		h.bus.submissions.subscribe(
			[parseFleetId("ci")],
			"start",
			async (envelope) => {
				seen.push(envelope);
			},
		);
		return seen;
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
	}

	it("signs the submission, journals fleet.WorkSubmitted on the work stream and publishes it", async () => {
		const h = await setup();
		const seen = published(h);
		const status = unwrap(await h.commands.submitWork(submission(), h.admin));
		expect(status.submissionId).toMatch(/^[0-9a-f]{32}$/u);
		expect(status.workDigest).toMatch(/^[0-9a-f]{32}$/u);
		expect(status.status).toBe(ReceiptStatus.UNSPECIFIED);
		expect(status.memberId).toBe("");
		await settle();
		expect(seen).toHaveLength(1);
		const envelope = seen[0];
		if (envelope === undefined) throw new Error("nothing published");
		expect(verifiesAs(h, envelope, WORK_SUBMISSION_CONTEXT)).toBe(true);
		const signed = fromBinary(WorkSubmissionSchema, envelope.payload);
		expect(signed).toMatchObject({
			submissionId: status.submissionId,
			tenant: "acme",
			fleet: "ci",
			author: "user:admin",
			image: "registry.example.com/tools/lint",
			imageDigest: DIGEST,
			argv: ["lint", "--all"],
			env: { MODE: "strict" },
			egressAllow: ["registry.example.com"],
		});
		expect(Date.parse(signed.expiresAt) - Date.parse(signed.submittedAt)).toBe(
			900_000,
		);
		const journal = await events(h.store, "fleet-work-");
		expect(journal.map((event) => [event.type, event.streamId])).toEqual([
			["fleet.WorkSubmitted", `fleet-work-${status.workDigest}`],
		]);
		expect(journal[0]?.data).toMatchObject({
			submissionId: status.submissionId,
			workDigest: status.workDigest,
			fleet: "ci",
			kind: "oci-command",
		});
	});

	it("publishes a submission once under retry, from one instance or two", async () => {
		const h = await setup();
		const seen = published(h);
		const other = h.another();
		const first = unwrap(await h.commands.submitWork(submission(), h.admin));
		const again = unwrap(await h.commands.submitWork(submission(), h.admin));
		const [raceA, raceB] = await Promise.all([
			h.commands.submitWork(submission(), h.admin),
			other.submitWork(submission(), h.admin),
		]);
		for (const status of [again, unwrap(raceA), unwrap(raceB)])
			expect(status.submissionId).toBe(first.submissionId);
		await settle();
		expect(seen).toHaveLength(1);
		expect(await events(h.store, "fleet-work-")).toHaveLength(1);
	});

	it("publishes the same work again only once the earlier submission has expired", async () => {
		const h = await setup();
		const seen = published(h);
		const first = unwrap(await h.commands.submitWork(submission(), h.admin));
		h.clock.advance(901_000);
		const second = unwrap(await h.commands.submitWork(submission(), h.admin));
		expect(second.submissionId).not.toBe(first.submissionId);
		const third = unwrap(await h.commands.submitWork(submission(), h.admin));
		expect(third.submissionId).toBe(second.submissionId);
		await settle();
		expect(seen).toHaveLength(2);
	});

	it("re-publishes a journalled submission whose publish failed, once", async () => {
		const bus = createMemoryBus(() => Date.parse("2026-11-01T10:00:00.000Z"));
		let failNext = true;
		const flaky = {
			...bus,
			submissions: {
				...bus.submissions,
				async publish(
					envelope: SignedEnvelope,
					fleet: ReturnType<typeof parseFleetId>,
				) {
					if (failNext) {
						failNext = false;
						throw new Error("bus down");
					}
					return bus.submissions.publish(envelope, fleet);
				},
			},
		};
		const h = await setup({ bus: flaky });
		const seen = published(h);
		expect(errorOf(await h.commands.submitWork(submission(), h.admin))).toBe(
			"unavailable",
		);
		const retried = unwrap(await h.commands.submitWork(submission(), h.admin));
		const again = unwrap(await h.commands.submitWork(submission(), h.admin));
		expect(again.submissionId).toBe(retried.submissionId);
		await settle();
		expect(seen).toHaveLength(1);
		expect(await events(h.store, "fleet-work-")).toHaveLength(1);
	});

	it("accepts an account credential", async () => {
		const h = await setup();
		const status = unwrap(
			await h.commands.submitWork(
				submission(),
				h.account(["fleet.work.submit"]),
			),
		);
		expect(status.submissionId).toMatch(/^[0-9a-f]{32}$/u);
	});

	const refusals: readonly Readonly<{
		name: string;
		code: string;
		rule?: string;
		run: (h: Harness) => ReturnType<Harness["commands"]["submitWork"]>;
	}>[] = [
		{
			name: "no caller",
			code: "unauthenticated",
			run: (h) => h.commands.submitWork(submission(), undefined),
		},
		{
			name: "a device credential",
			code: "unauthenticated",
			run: (h) => h.commands.submitWork(submission(), h.device(dev(1))),
		},
		{
			name: "a workload token",
			code: "unauthenticated",
			run: (h) => h.commands.submitWork(submission(), h.workload("acme/app")),
		},
		{
			name: "a person of another tenant",
			code: "forbidden",
			run: (h) =>
				h.commands.submitWork(submission(), {
					...h.admin,
					tenant: OTHER_TENANT,
				}),
		},
		{
			name: "policy denies fleet.work.submit",
			code: "forbidden",
			run: (h) => h.commands.submitWork(submission(), h.person([])),
		},
		{
			name: "an account without the scope",
			code: "forbidden",
			run: (h) => h.commands.submitWork(submission(), h.account([])),
		},
		{
			name: "a malformed fleet id",
			code: "invalid-request",
			run: (h) =>
				h.commands.submitWork(submission({ fleet: "Not Valid" }), h.admin),
		},
		{
			name: "an unknown fleet",
			code: "fleet-unknown",
			run: (h) => h.commands.submitWork(submission({ fleet: "nope" }), h.admin),
		},
		{
			name: "no image",
			code: "invalid-request",
			run: (h) => h.commands.submitWork(submission({ image: "" }), h.admin),
		},
		{
			name: "an image digest that is not sha256",
			code: "invalid-request",
			run: (h) =>
				h.commands.submitWork(submission({ imageDigest: "latest" }), h.admin),
		},
		{
			name: "a ttl above a day",
			code: "invalid-request",
			run: (h) =>
				h.commands.submitWork(submission({ ttlSeconds: 86_401 }), h.admin),
		},
		{
			name: "a malformed egress host",
			code: "invalid-request",
			run: (h) =>
				h.commands.submitWork(
					submission({ egressAllow: ["*.example.com"] }),
					h.admin,
				),
		},
		{
			name: "a fleet that does not take oci-command work",
			code: "fleet-policy",
			rule: "work-kind",
			run: (h) => h.commands.submitWork(submission({ fleet: "gha" }), h.admin),
		},
		{
			name: "an egress host the fleet does not allow",
			code: "fleet-policy",
			rule: "egress",
			run: (h) =>
				h.commands.submitWork(
					submission({ egressAllow: ["evil.example.com"] }),
					h.admin,
				),
		},
		{
			name: "an unknown sandbox tier in its needs",
			code: "invalid-request",
			run: (h) =>
				h.commands.submitWork(
					submission({
						needs: create(WorkNeedsSchema, { minSandbox: NOT_A_TIER }),
					}),
					h.admin,
				),
		},
	];
	for (const entry of refusals)
		it(`refuses ${entry.name} with ${entry.code}`, async () => {
			const h = await setup();
			const seen = published(h);
			const result = await entry.run(h);
			expect(result.ok ? "ok" : result.error.code).toBe(entry.code);
			if (entry.rule !== undefined && !result.ok)
				expect(result.error.detail?.rule).toBe(entry.rule);
			await settle();
			expect(seen).toEqual([]);
			expect(await events(h.store, "fleet-work-")).toEqual([]);
		});

	it("refuses work for a one-active fleet (local mode) with fleet-policy", async () => {
		const h = harness({ mode: "local" });
		const record = oneActiveRecord("cache");
		if (record.policy !== undefined) record.policy.workKinds = ["oci-command"];
		unwrap(await h.commands.defineFleet(record, h.admin));
		const result = await h.commands.submitWork(
			submission({ fleet: "cache", egressAllow: [] }),
			h.admin,
		);
		expect(
			result.ok ? "ok" : `${result.error.code}/${result.error.detail?.rule}`,
		).toBe("fleet-policy/coordination");
	});
});
